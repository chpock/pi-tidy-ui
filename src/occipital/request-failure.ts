/** Execution describes this request attempt only, never transport loss or
 * earlier work for the same logical source. Unknown is the safe default after
 * handing a request to the pipe/SDK or discarding an old-provider reply. */
export class RequestFailure extends Error {
  readonly execution: 'not_started' | 'unknown';
  constructor(message: string, execution: 'not_started' | 'unknown' = 'unknown') {
    super(message);
    this.execution = execution;
  }
}
