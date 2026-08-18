/**
 * webServer 服务的最小类型面（dsh host 提供）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface WebServerRoute {
  kind: 'prefix' | 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface WebServerService {
  register(route: WebServerRoute): () => void
}
