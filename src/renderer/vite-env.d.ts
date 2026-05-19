/// <reference types="vite/client" />

import type { MapsLeadsApi } from "../shared/types";

declare global {
  interface Window {
    mapsLeads: MapsLeadsApi;
  }
}
