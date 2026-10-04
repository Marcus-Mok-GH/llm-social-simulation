import { useEffect, useState } from "react";

const COARSE = "(pointer: coarse)";
const NARROW = "(max-width: 767px)";

function read(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(COARSE).matches || window.matchMedia(NARROW).matches;
}

/**
 * True on phones/tablets (coarse primary pointer) or any narrow viewport.
 * Drives the on-screen joystick and the compact HUD arrangement; the initial
 * value is computed synchronously so the first paint is already correct, then
 * kept in sync as the viewport or input device changes.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(read);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const coarse = window.matchMedia(COARSE);
    const narrow = window.matchMedia(NARROW);
    const update = () => setIsMobile(coarse.matches || narrow.matches);
    update();
    coarse.addEventListener("change", update);
    narrow.addEventListener("change", update);
    return () => {
      coarse.removeEventListener("change", update);
      narrow.removeEventListener("change", update);
    };
  }, []);

  return isMobile;
}
