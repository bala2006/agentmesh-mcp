import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

export interface MultimodalResult {
  mode: 'text' | 'asset';
  status: 'completed' | 'provider_required';
  summary: string;
  confidence: number | null;
  warnings: string[];
  metadata?: Record<string, unknown>;
}

export async function analyzeMultimodalInput(input: {
  mode: 'text' | 'asset';
  content: string;
  goal: string;
}): Promise<MultimodalResult> {
  if (input.mode === 'text') {
    return {
      mode: 'text',
      status: 'completed',
      summary: `Text analysis request received for goal: ${input.goal}. Content length: ${input.content.length} characters.`,
      confidence: null,
      warnings: [
        'This local MVP stores the analysis contract but does not call a hosted vision model.',
      ],
    };
  }

  const filePath = resolve(input.content);
  try {
    const file = await stat(filePath);
    return {
      mode: 'asset',
      status: 'provider_required',
      summary: `Asset ${basename(filePath)} is ready for multimodal processing. Configure a provider worker to perform OCR or image understanding.`,
      confidence: null,
      warnings: [
        'No multimodal provider is enabled in the local MVP.',
        'Do not treat this result as OCR or visual understanding.',
      ],
      metadata: {
        path: filePath,
        sizeBytes: file.size,
        modifiedAt: file.mtime.toISOString(),
        goal: input.goal,
      },
    };
  } catch {
    return {
      mode: 'asset',
      status: 'provider_required',
      summary: `Asset path could not be read: ${filePath}`,
      confidence: 0,
      warnings: ['Verify the path is inside an allowed workspace before retrying.'],
      metadata: { path: filePath, goal: input.goal },
    };
  }
}
