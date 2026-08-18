/// <reference types="vite/client" />

// Vite resolves image imports to a URL string at build time; TypeScript needs
// telling that separately.
declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
