/// <reference types="vite/client" />
declare module 'bidi-js' {
  interface Bidi {
    getEmbeddingLevels(
      text: string,
      baseDirection?: 'ltr' | 'rtl' | 'auto',
    ): { levels: Uint8Array; paragraphs: unknown[] };
    getReorderSegments(text: string, embeddingLevels: unknown, start?: number, end?: number): [number, number][];
  }
  const factory: () => Bidi;
  export default factory;
}
