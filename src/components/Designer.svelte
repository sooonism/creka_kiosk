<script lang="ts">
  import { onMount } from "svelte";
  import { DEFAULT_DESIGN, type Design } from "../lib/design";

  let me = $state<string | null>(null);
  let checked = $state(false);
  let email = $state("");
  let otp = $state("");
  let sent = $state(false);
  let msg = $state("");
  let design = $state<Design>(DEFAULT_DESIGN);

  const loadDesign = async () => (design = await fetch("/api/design").then((r) => r.json()));
  onMount(async () => {
    const r = await fetch("/api/designer-auth");
    me = r.ok ? (await r.json()).email : null;
    checked = true;
    if (me) loadDesign();
  });

  async function auth(body: object) {
    const r = await fetch("/api/designer-auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    msg = r.ok ? "" : `error: ${(await r.json()).error}`;
    return r.ok;
  }
  const sendCode = async () => (sent = await auth({ email }));
  const verify = async () => {
    if (!(await auth({ email, otp }))) return;
    me = email; otp = ""; sent = false;
    loadDesign();
  };
  const logout = async () => { await fetch("/api/designer-auth", { method: "DELETE" }); me = null; };

  async function send(res: Response) {
    const j = await res.json();
    if (res.ok) (design = j), (msg = "saved, kiosks pick it up on their next page reload");
    else msg = `error: ${j.error}`;
  }
  async function upload(kind: "bg" | "pose", e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = ""; // so the same file can be picked again
    if (!file) return;
    msg = "uploading…";
    const body = new FormData();
    body.append("kind", kind);
    body.append("file", file);
    await send(await fetch("/api/design", { method: "POST", body }));
  }
  const remove = async (kind: "bg" | "pose", url = "") =>
    send(await fetch(`/api/design?kind=${kind}&url=${encodeURIComponent(url)}`, { method: "DELETE" }));
</script>

<h1>Nkob designer</h1>
{#if !checked}
  <p class="hint">…</p>
{:else if !me}
  <form class="card login" onsubmit={(e) => (e.preventDefault(), sent ? verify() : sendCode())}>
    <h3>Designer login</h3>
    <input type="email" placeholder="your email" bind:value={email} required />
    {#if sent}<input inputmode="numeric" placeholder="code from email" bind:value={otp} required />{/if}
    <button>{sent ? "Verify" : "Send code"}</button>
    <span class="msg">{msg}</span>
  </form>
{:else}
  <p class="hint">{me} · <button class="link" onclick={logout}>sign out</button> <span class="msg">{msg}</span></p>

  <section class="card">
    <h3>Background</h3>
    <img class="bg" src={design.bg} alt="Current background" />
    <label class="up">Upload new background<input type="file" accept="image/png,image/webp,image/jpeg" onchange={(e) => upload("bg", e)} /></label>
    {#if design.bg !== DEFAULT_DESIGN.bg}<button onclick={() => remove("bg")}>Reset to original</button>{/if}
    <p class="hint">Fills the whole screen (cropped to cover). Use the kiosk's orientation, max 8 MB.</p>
  </section>

  <section class="card">
    <h3>Nkob expressions <small>({design.poses.length}, the live cam cycles through them)</small></h3>
    <div class="poses">
      {#each design.poses as url}
        <figure>
          <img src={url} alt="Nkob expression" />
          <button class="del" onclick={() => remove("pose", url)} disabled={design.poses.length <= 2}>Delete</button>
        </figure>
      {/each}
    </div>
    <label class="up">Add expression<input type="file" accept="image/png,image/webp" onchange={(e) => upload("pose", e)} /></label>
    <p class="hint">Transparent PNG/WebP, same framing as the existing ones. At least 2 are kept.</p>
  </section>
{/if}

<style>
  .card { background: #1a1d27; border: 1px solid #2a2d37; border-radius: 10px; padding: 1rem; margin: 1rem 0; }
  .login { display: flex; flex-direction: column; gap: 0.5rem; max-width: 20rem; }
  .hint { color: #8b8fa3; font-size: 0.85rem; }
  .msg { margin-left: 0.5rem; color: #a78bfa; }
  input, button { background: #0f1117; color: #e1e4ea; border: 1px solid #2a2d37; border-radius: 6px; padding: 0.35rem 0.5rem; font: inherit; }
  button { cursor: pointer; }
  button:hover:not(:disabled) { border-color: #a78bfa; }
  button:disabled { opacity: 0.4; cursor: default; }
  .link { background: none; border: 0; color: #a78bfa; padding: 0; }
  .up { display: flex; flex-direction: column; gap: 0.3rem; margin: 0.75rem 0; font-size: 0.85rem; }
  .bg { max-width: 100%; max-height: 16rem; border-radius: 6px; }
  .poses { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: 0.75rem; }
  figure { margin: 0; display: flex; flex-direction: column; gap: 0.4rem; align-items: center; background: #0f1117; border-radius: 8px; padding: 0.5rem; }
  figure img { max-width: 100%; max-height: 9rem; }
  .del:hover:not(:disabled) { border-color: #f87171; }
</style>
