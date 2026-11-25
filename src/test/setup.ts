import { disposeVisibilityTracking } from "../platform/tiktok/lifecycle";
import { coverLoader } from "../components/coverLoader";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import { text } from "../copy";

afterEach(async () => {
  cleanup();
  disposeVisibilityTracking();
  coverLoader.dispose();
  document.documentElement.lang = "en";
});
