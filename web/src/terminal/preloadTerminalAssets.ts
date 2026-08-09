type TerminalAssetModules = {
  clipboardModule: typeof import('@xterm/addon-clipboard')
  fitModule: typeof import('@xterm/addon-fit')
  unicode11Module: typeof import('@xterm/addon-unicode11')
  xtermModule: typeof import('@xterm/xterm')
}

let terminalAssetsPromise: Promise<TerminalAssetModules> | undefined

export const preloadTerminalAssets = (): Promise<TerminalAssetModules> => {
  terminalAssetsPromise ??= Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-unicode11'),
    import('@xterm/addon-clipboard'),
  ])
    .then(([xtermModule, fitModule, unicode11Module, clipboardModule]) => ({
      clipboardModule,
      fitModule,
      unicode11Module,
      xtermModule,
    }))
    .catch((error: unknown) => {
      terminalAssetsPromise = undefined
      throw error
    })
  return terminalAssetsPromise
}
