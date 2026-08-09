export const buildPendingImageArtifactPrompt = (
  source: 'Desktop' | 'Mobile',
  fileName: string
): string =>
  [
    `${source} image attachment: ${fileName}`,
    'Yive Runtime will bind this upload to a validated Workspace-relative Artifact.',
  ].join('\n')
