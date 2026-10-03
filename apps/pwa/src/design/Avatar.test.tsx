import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./Avatar.js";

describe("Avatar (monogram identity, design §E.1)", () => {
  it("renders uppercase initials with the student's fixed hue class", () => {
    render(<Avatar initials="ab" />);
    const el = screen.getByRole("img", { name: "student AB" });
    expect(el).toHaveTextContent("AB");
    expect(el.className).toContain("av circle");
    expect(el.className).toContain("ab");
    expect(el.className).not.toContain("sm");
  });

  it("adds the small variant class when requested", () => {
    render(<Avatar initials="CD" small />);
    expect(screen.getByRole("img", { name: "student CD" }).className).toContain("sm");
  });

  it("tightens the type for 3-letter initials only (TEACH-40)", () => {
    render(<Avatar initials="jms" small />);
    expect(screen.getByRole("img", { name: "student JMS" }).className).toContain("tri");
    render(<Avatar initials="JM" />);
    expect(screen.getByRole("img", { name: "student JM" }).className).not.toContain("tri");
  });
});
