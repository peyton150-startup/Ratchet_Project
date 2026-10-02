/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute origin of the API (e.g. https://api.example.com). Set in the Vercel project
   * for production; left unset in dev, where the Vite proxy keeps the API same-origin.
   */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
