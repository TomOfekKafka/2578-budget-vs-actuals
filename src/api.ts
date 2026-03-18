const MCP_BASE = 'https://mcp-poc-tom.azurewebsites.net';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

let _sessionId = '';
let _csrfToken = '';

let _resolveCredentials: () => void;
export const credentialsReady = new Promise<void>((resolve) => {
  _resolveCredentials = resolve;
});

function handleMessage(event: MessageEvent) {
  console.log('[BvA] postMessage received:', event.data, 'origin:', event.origin);
  const { type, payload } = event.data ?? {};
  if (type === 'init' && payload) {
    const { sessionid, csrftoken } = payload;
    console.log('[BvA] init payload:', { sessionid: !!sessionid, csrftoken: !!csrftoken });
    if (sessionid && csrftoken) {
      _sessionId = sessionid;
      _csrfToken = csrftoken;
      _resolveCredentials();
    }
  }
}

// Register immediately at module load — before React mounts
console.log('[BvA] Registering postMessage listener (module load)');
window.addEventListener('message', handleMessage);

export async function callMcpTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!_sessionId || !_csrfToken) {
    throw new AuthError('No credentials received yet');
  }
  const response = await fetch(MCP_BASE + '/api/tool', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': _sessionId,
      'X-Csrf-Token': _csrfToken,
      'X-Domain': import.meta.env.VITE_DR_DOMAIN || 'app.datarails.com',
    },
    body: JSON.stringify({ tool: toolName, args }),
  });
  if (!response.ok) {
    const body = await response.text();
    if (
      response.status === 401 ||
      response.status === 403 ||
      /missing auth headers/i.test(body) ||
      /auth/i.test(body)
    ) {
      throw new AuthError(body);
    }
    throw new Error(body);
  }
  return await response.json();
}
