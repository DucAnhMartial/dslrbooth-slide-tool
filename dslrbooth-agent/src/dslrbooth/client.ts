import http from 'http'

export interface ApiResult {
  isSuccessful: boolean
  errorMessage: string
  rawResponse: string
}

export class DslrBoothClient {
  constructor(
    private readonly port: number,
    private readonly password: string,
  ) {}

  call(action: string, password: string, params: Record<string, string> = {}): Promise<ApiResult> {
    const url = new URL(`http://127.0.0.1:${this.port}/api/${action}`)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    url.searchParams.set('password', password)

    return new Promise((resolve) => {
      const req = http.get(url, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            resolve({
              isSuccessful: parsed.IsSuccessful === true,
              errorMessage: parsed.ErrorMessage || '',
              rawResponse: body,
            })
          } catch {
            resolve({
              isSuccessful: false,
              errorMessage: `Invalid JSON response: ${body.slice(0, 200)}`,
              rawResponse: body,
            })
          }
        })
      })

      req.on('error', (err) => {
        resolve({
          isSuccessful: false,
          errorMessage: `Connection failed: ${err.message}`,
          rawResponse: '',
        })
      })

      req.setTimeout(10000, () => {
        req.destroy()
        resolve({
          isSuccessful: false,
          errorMessage: 'Request timeout (10s)',
          rawResponse: '',
        })
      })
    })
  }

  startSession(mode: string = 'print'): Promise<ApiResult> {
    return this.call('start', this.password, { mode })
  }
}
