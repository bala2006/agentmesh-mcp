const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
const PIXEL_VALUE = /\b\d+(?:\.\d+)?px\b/;

export interface DesignCheckResult {
  passed: boolean;
  issues: Array<{ code: string; severity: 'warning' | 'error'; message: string }>;
  summary: string;
}

export function checkDesignInput(input: {
  uiSummary: string;
  tokens?: string;
  accessibilityNotes?: string;
}): DesignCheckResult {
  const issues: DesignCheckResult['issues'] = [];
  const combined = `${input.uiSummary}\n${input.tokens ?? ''}`;

  if (HEX_COLOR.test(combined)) {
    issues.push({
      code: 'raw-color',
      severity: 'warning',
      message: 'Raw color values were found. Prefer semantic design tokens.',
    });
  }

  if (PIXEL_VALUE.test(input.uiSummary)) {
    issues.push({
      code: 'raw-dimension',
      severity: 'warning',
      message: 'Raw pixel dimensions were found. Prefer spacing and typography tokens.',
    });
  }

  const accessibility = input.accessibilityNotes?.toLowerCase() ?? '';
  if (!accessibility.includes('focus')) {
    issues.push({
      code: 'missing-focus-state',
      severity: 'error',
      message: 'The review does not describe keyboard focus behavior.',
    });
  }
  if (!accessibility.includes('contrast')) {
    issues.push({
      code: 'missing-contrast-check',
      severity: 'warning',
      message: 'Add a color-contrast check to the design review.',
    });
  }

  const errors = issues.filter((issue) => issue.severity === 'error').length;
  return {
    passed: errors === 0,
    issues,
    summary:
      issues.length === 0
        ? 'No issues detected by the baseline design-system checks.'
        : `${issues.length} issue(s) detected; ${errors} error(s) require attention.`,
  };
}
