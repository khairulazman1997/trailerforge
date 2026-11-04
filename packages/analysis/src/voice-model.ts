import type { ModelManifest } from './models.js';

/**
 * The pinned voice model: faster-whisper "small" (CTranslate2 conversion of OpenAI Whisper small,
 * multilingual), exact URLs at a fixed revision, sizes and sha256 of each file. `model.bin`'s
 * sha256 is its Git LFS object id; the other three were hashed after download.
 */
export const PINNED_VOICE_MODEL: ModelManifest | null = {
  id: 'whisper-small-ct2',
  title: 'Whisper small (faster-whisper / CTranslate2, multilingual)',
  license: 'MIT',
  source: 'Systran/faster-whisper-small@536b0662742c02347bc0e980a01041f333bce120',
  servedFrom: ['us.aws.cdn.hf.co'],
  files: [
    {
      name: 'config.json',
      url: 'https://huggingface.co/Systran/faster-whisper-small/resolve/536b0662742c02347bc0e980a01041f333bce120/config.json',
      bytes: 2370,
      sha256: 'b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828',
    },
    {
      name: 'model.bin',
      url: 'https://huggingface.co/Systran/faster-whisper-small/resolve/536b0662742c02347bc0e980a01041f333bce120/model.bin',
      bytes: 483546902,
      sha256: '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671',
    },
    {
      name: 'tokenizer.json',
      url: 'https://huggingface.co/Systran/faster-whisper-small/resolve/536b0662742c02347bc0e980a01041f333bce120/tokenizer.json',
      bytes: 2203239,
      sha256: 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab',
    },
    {
      name: 'vocabulary.txt',
      url: 'https://huggingface.co/Systran/faster-whisper-small/resolve/536b0662742c02347bc0e980a01041f333bce120/vocabulary.txt',
      bytes: 459861,
      sha256: '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913',
    },
  ],
};
