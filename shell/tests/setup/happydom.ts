// Register a happy-dom window/document as globals BEFORE any test module
// (and react-dom) loads, so @testing-library/react can render into a DOM.
// Loaded via bunfig.toml [test].preload.
import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()
