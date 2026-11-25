import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

import { AgreementPage, PrivacyPolicyPage } from "./LegalPage";

vi.mock("../config/applicationProfile", () => ({
  currentApplicationProfile: () => ({ name: "Plotimo" }),
}));

it("内置隐私政策在标题下标明认证主体，正文和联系方式保持同名", () => {
  const { container } = render(<MemoryRouter><PrivacyPolicyPage /></MemoryRouter>);
  expect(screen.getByRole("heading", { level: 1, name: "Plotimo Privacy Policy" })).toBeInTheDocument();
  expect(container.querySelector(".legal-header")).toHaveTextContent("Legal entity: IGNITE GAMES PTY LTD");
  expect(container).toHaveTextContent("Company: IGNITE GAMES PTY LTD");
  expect(Array.from(container.querySelectorAll("strong"), (node) => node.textContent)).not.toContain("IGNITE GAMES PTY LTD.");
});

it("内置服务条款使用相同的认证主体名称", () => {
  const { container } = render(<MemoryRouter><AgreementPage /></MemoryRouter>);
  expect(container).toHaveTextContent("operated by IGNITE GAMES PTY LTD");
  expect(container).toHaveTextContent("Company: IGNITE GAMES PTY LTD");
  expect(Array.from(container.querySelectorAll("strong"), (node) => node.textContent)).not.toContain("IGNITE GAMES PTY LTD.");
});
