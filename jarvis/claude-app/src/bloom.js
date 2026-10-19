/* Realce opcional da galáxia: three (ESM) + UnrealBloomPass. Falhou? A página segue igual, sem brilho. */
(async function () {
  try {
    const THREE = await import("three");
    const mod = await import("three/addons/postprocessing/UnrealBloomPass.js");
    window.dispatchEvent(new CustomEvent("jarvis:three", { detail: { THREE: THREE, UnrealBloomPass: mod && mod.UnrealBloomPass } }));
  } catch (e) {
    console.warn("JARVIS: realce 3D indisponível; a galáxia segue sem brilho.", e && e.message ? e.message : e);
  }
})();
