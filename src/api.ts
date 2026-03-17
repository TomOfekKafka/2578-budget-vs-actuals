const MCP_BASE = 'https://mcp-poc-tom.azurewebsites.net';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

let _sessionId = '';
let _csrfToken = '';

export function setCredentials(sessionId: string, csrfToken: string) {
  _sessionId = sessionId;
  _csrfToken = csrfToken;
}

export function hasCredentials(): boolean {
  return _sessionId !== '' && _csrfToken !== '';
}

export async function callMcpTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!hasCredentials()) {
    throw new AuthError('No credentials received yet');
  }
  const response = await fetch(MCP_BASE + '/api/tool', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': _sessionId,
      'X-Csrf-Token': _csrfToken,
      'X-Domain': import.meta.env.VITE_DR_DOMAIN ?? '',
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
