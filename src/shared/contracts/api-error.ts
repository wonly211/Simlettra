export interface ApiErrorResponse {
  error: {
    code: string
    message: string
    field?: string
  }
}
