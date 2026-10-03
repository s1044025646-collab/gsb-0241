export type ErrorCode =
  | 'INVALID_ARG'
  | 'NOT_FOUND'
  | 'BAD_HEADER_MAGIC'
  | 'BAD_HEADER_VERSION'
  | 'TRUNCATED_HEADER'
  | 'BAD_CODETABLE'
  | 'TRUNCATED_PAYLOAD'
  | 'BAD_PAYLOAD'
  | 'BAD_PAD_BITS'
  | 'LENGTH_MISMATCH'
  | 'OUTPUT_TOO_LARGE'
  | 'CHECKSUM_MISMATCH'
  | 'IO_ERROR';

export class HfError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'HfError';
    this.code = code;
    this.status = status;
  }
}

export const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_ARG: 400,
  NOT_FOUND: 404,
  BAD_HEADER_MAGIC: 400,
  BAD_HEADER_VERSION: 400,
  TRUNCATED_HEADER: 400,
  BAD_CODETABLE: 400,
  TRUNCATED_PAYLOAD: 400,
  BAD_PAYLOAD: 400,
  BAD_PAD_BITS: 400,
  LENGTH_MISMATCH: 400,
  OUTPUT_TOO_LARGE: 400,
  CHECKSUM_MISMATCH: 400,
  IO_ERROR: 500,
};
