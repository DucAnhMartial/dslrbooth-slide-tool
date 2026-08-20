import http from 'http'

export interface ApiResult {
  isSuccessful: boolean
  errorMessage: string
  rawResponse: string
}

export class DslrBoothClient {
  /**
   * `port` and `password` were `readonly` until plan 08-04, which was exactly
   * correct for values that never changed — and exactly wrong the moment UI-02
   * let an operator change them from the CMS. A `readonly` field here means a
   * config update applied anywhere else has no effect on the instance that
   * actually calls dslrBooth: the Agent keeps its boot-time credentials
   * forever, with no error and no warning anywhere (08-RESEARCH Pitfall 4).
   *
   * Nothing else about this class changed: `call()` still reads `this.port` at
   * request time and still takes the password as an explicit argument.
   */
  constructor(
    private port: number,
    private password: string,
  ) {}

  /**
   * Replaces the credentials used by every SUBSEQUENT call. In-flight requests
   * already hold their URL and are unaffected.
   *
   * Neither value is logged here or anywhere else in this class.
   */
  updateCredentials(port: number, password: string): void {
    this.port = port
    this.password = password
  }

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
