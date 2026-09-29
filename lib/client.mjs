import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

export class JevError extends Error {
  constructor(message, code = 'invalid_input') { super(message); this.name = 'JevError'; this.code = code; }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const content = value => typeof value === 'string' || object(value) || Array.isArray(value);
const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;
const requireValid = (valid, message, code) => { if (!valid) throw new JevError(message, code); };
const sameKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const MAX_BYTES = 1024 * 1024;
const EPSILON = 0.0001;

function validateRequest(request) {
  const bad = 'Invalid TypeSafe request';
  requireValid(object(request) && content(request.state) && object(request.questions), bad);
  requireValid(typeof request.model === 'string' && request.model.trim().length > 0, bad);
  requireValid(Object.keys(request.questions).length > 0, bad);
  for (const [id, q] of Object.entries(request.questions)) {
    requireValid(id.length > 0 && object(q) && content(q.instructions), bad);
    if (q.type === 'noul') {
      if (q.criteria !== undefined) requireValid(object(q.criteria) && Object.keys(q.criteria).every(key => ['true', 'false'].includes(key)) && Object.values(q.criteria).every(content), bad);
    } else if (q.type === 'choice') {
      requireValid(object(q.criteria), bad);
      const keys = Object.keys(q.criteria);
      requireValid(keys.length > 0 && keys.length <= 255 && keys.every(key => key.length > 0), bad);
      requireValid(Object.values(q.criteria).every(value => value === null || content(value)), bad);
    } else if (q.type === 'score') {
      requireValid(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 10 && q.criteria.every(content), bad);
    } else throw new JevError(bad);
  }
}

function validateEnvelope(data, questions) {
  const bad = 'Invalid TypeSafe response';
  requireValid(object(data) && typeof data.model === 'string' && data.model.trim().length > 0, bad);
  requireValid(object(data.usage) && ['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(data.usage[key]) && data.usage[key] >= 0), bad);
  requireValid(sameKeys(data.answers, Object.keys(questions)), bad);
  for (const [id, q] of Object.entries(questions)) {
    const a = data.answers[id];
    requireValid(object(a) && a.type === q.type, bad);
    if (q.type === 'noul') { requireValid(probability(a.noul), bad); continue; }
    const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    requireValid(probability(a.confidence) && sameKeys(a.probabilities, keys), bad);
    const probabilities = Object.values(a.probabilities);
    // Each serialized probability can round by 0.005; cap aggregate drift at 5%.
    const tolerance = Math.min(0.05, 0.005 * keys.length + EPSILON);
    requireValid(probabilities.every(probability) && Math.abs(probabilities.reduce((sum, p) => sum + p, 0) - 1) <= tolerance, bad);
    if (q.type === 'choice') {
      requireValid(typeof a.choice === 'string' && keys.includes(a.choice), bad);
      requireValid(a.probabilities[a.choice] >= Math.max(...probabilities) - EPSILON, bad);
    } else {
      requireValid(sameKeys(a.legend, keys) && keys.every(key => isDeepStrictEqual(a.legend[key], q.criteria[key])), bad);
      requireValid(Number.isFinite(a.score) && a.score >= 0 && a.score <= keys.length - 1, bad);
    }
  }
  return data;
}

function credential(env, keychain, timeout) {
  const selector = env.TYPESAFE_API_KEY_ENV ?? 'TYPESAFE_API_KEY';
  requireValid(/^[A-Za-z_][A-Za-z0-9_]*$/.test(selector), 'Invalid credential selector', 'configuration_error');
  let key = env[selector];
  if (!key && keychain && process.platform === 'darwin' && env.TYPESAFE_API_KEY_ENV === undefined) {
    try {
      key = execFileSync('security', ['find-generic-password', '-a', env.USER ?? '', '-s', 'typesafe-api-key', '-w'], {
        encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16384,
      }).trim();
    } catch { throw new JevError('TypeSafe credential unavailable', 'credential_error'); }
  }
  requireValid(typeof key === 'string' && key.length > 0 && !/[\s\x00-\x1f\x7f]/.test(key), 'TypeSafe credential unavailable', 'credential_error');
  return key;
}

// options.env replaces process.env; keychain is opt-in for legacy CLI/MCP callers.
export async function evaluate(input, { env = process.env, keychain = false } = {}) {
  let request, body, url, timeout;
  try {
    request = { state: input.state, questions: input.questions, model: input.model === undefined ? (env.TYPESAFE_MODEL ?? 'jev-latest') : input.model };
    body = JSON.stringify(request);
    requireValid(Buffer.byteLength(body) <= MAX_BYTES, 'TypeSafe request too large');
    request = JSON.parse(body);
    validateRequest(request);
    url = new URL(env.TYPESAFE_API_URL ?? 'https://api.typesafe.ai/v1/systemone');
    const local = env.TYPESAFE_API_URL && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    requireValid((url.protocol === 'https:' || (local && url.protocol === 'http:')) && !url.username && !url.password && !url.hash, 'Invalid TypeSafe endpoint', 'configuration_error');
    if (['CSH_AGENTIC_CODING_KEY', 'ASCII_AGENTIC_CODING_KEY', 'CSH_OPENAI_PULL_THROUGH_TOKEN', 'LITELLM_KEY'].includes(env.TYPESAFE_API_KEY_ENV)) {
      requireValid(env.TYPESAFE_API_URL && (local || (url.protocol === 'https:' && url.hostname === 'llm.ascii.ac.at' && !url.port)),
        'CSH credentials require an explicit https://llm.ascii.ac.at endpoint (or a loopback test endpoint with a dummy key)', 'credential_host_mismatch');
    }
    timeout = Number(env.TYPESAFE_TIMEOUT_MS ?? 8000);
    requireValid(Number.isInteger(timeout) && timeout > 0 && timeout <= 120000, 'Invalid TypeSafe timeout', 'configuration_error');
  } catch (error) { throw error instanceof JevError ? error : new JevError('Invalid TypeSafe request or configuration'); }
  const key = credential(env, keychain, timeout);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url.href, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new JevError(`TypeSafe HTTP ${response.status}`, 'http_error');
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      requireValid(size <= MAX_BYTES, 'TypeSafe response too large', 'invalid_response');
      chunks.push(chunk);
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return validateEnvelope(data, request.questions);
    } catch { throw new JevError('Invalid TypeSafe response', 'invalid_response'); }
  } catch (error) {
    if (error instanceof JevError) throw error;
    throw new JevError(controller.signal.aborted ? 'TypeSafe request timed out' : 'TypeSafe request failed', controller.signal.aborted ? 'timeout' : 'network_error');
  } finally { clearTimeout(timer); }
}
