# macOS app template

`app-template/` is the checked-in skeleton used to assemble `maximal.app`.

## Template contract

- `Contents/Info.plist` contains `__VERSION__`, replaced during assembly.
- `Contents/MacOS/maximal.placeholder` marks where the compiled `maximal`
  binary is installed.
- `Contents/MacOS/first-launch` installs the bundled CLI and launch agent.
- `Contents/Resources/co.stuffbucket.maximal.plist` contains `__HOME__` and
  `__INSTALL_BIN__`, replaced by `first-launch`.
- `Contents/Resources/AppIcon.icns` is the application icon.
- `maximal.entitlements` declares the app's signing entitlements.

Keep sentinel names stable: the assembly and first-launch scripts replace them
literally.
