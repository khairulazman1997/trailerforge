import type { VisionModelManifest } from './vision.js';

/**
 * The pinned vision model: exact URLs (at a fixed revision), sizes and sha256 of each file.
 * Written by `node scripts/pin-vision-model.mjs`; do not edit by hand.
 */
export const PINNED_VISION_MODEL: VisionModelManifest | null = {
  id: 'clip-vit-b32',
  title: 'CLIP ViT-B/32 (CLIP-ViT-B-32-laion2B-s34B-b79K-ONNX, quantized ONNX)',
  license: 'MIT',
  source:
    'onnx-community/CLIP-ViT-B-32-laion2B-s34B-b79K-ONNX@de693d0c5a5b263ae94ece9bf751e0cda14305d8',
  files: [
    {
      name: 'model.onnx',
      url: 'https://huggingface.co/onnx-community/CLIP-ViT-B-32-laion2B-s34B-b79K-ONNX/resolve/de693d0c5a5b263ae94ece9bf751e0cda14305d8/onnx/model_quantized.onnx',
      bytes: 152708043,
      sha256: '2ac8410fe198fbd003cd97460bdd68653d99c33f53311881cd306190067aee9b',
    },
    {
      name: 'tokenizer.json',
      url: 'https://huggingface.co/onnx-community/CLIP-ViT-B-32-laion2B-s34B-b79K-ONNX/resolve/de693d0c5a5b263ae94ece9bf751e0cda14305d8/tokenizer.json',
      bytes: 3642073,
      sha256: '6d9109cc838977f3ca94a379eec36aecc7c807e1785cd729660ca2fc0171fb35',
    },
  ],
};
