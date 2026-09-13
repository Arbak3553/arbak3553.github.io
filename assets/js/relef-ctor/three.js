// Relative re-export of three: import maps are document-scoped and module
// WORKERS do not inherit them, so geometry modules (disc/pendant/earring)
// import './three.js' instead of bare 'three'. On the page this resolves to
// the same URL the import map points at — one module instance either way.
export * from '../three.module.min.js';
