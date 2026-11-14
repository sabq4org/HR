declare module 'bidi-js' {
  type EmbeddingLevels = {
    levels: Uint8Array;
    paragraphs: { start: number; end: number; level: number }[];
  };
  type Bidi = {
    getEmbeddingLevels(text: string, direction?: 'ltr' | 'rtl'): EmbeddingLevels;
    getReorderSegments(
      text: string,
      levels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): [number, number][];
    getMirroredCharacter(char: string): string | null;
    getMirroredCharactersMap(
      text: string,
      levels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): Map<number, string>;
  };
  export default function bidiFactory(): Bidi;
}
