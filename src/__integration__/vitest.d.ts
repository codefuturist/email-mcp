declare module 'vitest' {
  export interface ProvidedContext {
    greenmailHost: string;
    greenmailSmtpPort: number;
    greenmailImapPort: number;
  }
}
