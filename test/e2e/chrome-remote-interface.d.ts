declare module 'chrome-remote-interface' {
  interface Client {
    close(): Promise<void>
    send(method: string, params?: object, sessionId?: string): Promise<unknown>
  }

  interface ConnectOptions {
    target: string
  }

  export default function connect(options: ConnectOptions): Promise<Client>
}
