/** An error with an HTTP status, turned into `{"error": message}` by the API. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
