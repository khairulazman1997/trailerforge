export type MediaErrorCode =
  | 'ffmpeg-missing'
  | 'file-not-found'
  | 'permission-denied'
  | 'corrupt-file'
  | 'unsupported-codec'
  | 'out-of-disk'
  | 'cancelled'
  | 'timeout'
  | 'process-failed';

/** Codes where retrying the same operation cannot help. */
const PERMANENT: ReadonlySet<MediaErrorCode> = new Set([
  'ffmpeg-missing',
  'file-not-found',
  'permission-denied',
  'corrupt-file',
  'unsupported-codec',
]);

export class MediaError extends Error {
  constructor(
    readonly code: MediaErrorCode,
    message: string,
    /** Tail of ffmpeg/ffprobe stderr, for logs and bug reports. */
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'MediaError';
  }

  get retryable(): boolean {
    return !PERMANENT.has(this.code);
  }
}

const PATTERNS: [RegExp, MediaErrorCode, string][] = [
  [/No space left on device|ENOSPC/i, 'out-of-disk', 'Not enough disk space'],
  [/No such file or directory/i, 'file-not-found', 'File not found'],
  [/Permission denied|EACCES/i, 'permission-denied', 'Permission denied'],
  [
    /Unknown encoder|Encoder not found|Decoder \(codec .*\) not found|could not find codec|Unsupported codec/i,
    'unsupported-codec',
    'Codec not supported by this FFmpeg build',
  ],
  [
    /Invalid data found when processing input|moov atom not found|End of file|Invalid NAL unit|error while decoding|Failed to read frame size/i,
    'corrupt-file',
    'File is corrupt or not a media file',
  ],
];

/** Map a failed ffmpeg/ffprobe run to a typed error a user can act on. */
export function classifyFailure(tool: string, stderr: string, exitCode: number | null): MediaError {
  const tail = stderr.trim().split('\n').slice(-15).join('\n');
  for (const [re, code, message] of PATTERNS) {
    if (re.test(stderr)) return new MediaError(code, `${message} (${tool})`, tail);
  }
  return new MediaError('process-failed', `${tool} exited with code ${exitCode}`, tail);
}
