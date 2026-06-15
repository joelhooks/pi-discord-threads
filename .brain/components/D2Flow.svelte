<script lang="ts">
  type Props = {
    src: string;
    title?: string;
    caption?: string;
    source?: string;
  };

  let { src, title = "D2 flow chart", caption, source }: Props = $props();

  const workspaceRoot = import.meta.env.VITE_PI_NOTES_WORKSPACE_ROOT as string;
  const normalizedSrc = $derived(src.replace(/^\.\//, ""));
  const normalizedSource = $derived(source?.replace(/^\.\//, ""));
  const imageSrc = $derived(`/@fs/${workspaceRoot}/${normalizedSrc}`);
</script>

<figure class="d2-flow" data-nested-selectable-root>
  <div class="frame">
    <img src={imageSrc} alt={title} loading="lazy" />
  </div>
  <figcaption>
    <strong>{title}</strong>
    {#if caption}
      <span>{caption}</span>
    {/if}
    {#if normalizedSource}
      <code>{normalizedSource}</code>
    {/if}
  </figcaption>
</figure>

<style>
  .d2-flow {
    margin: 1.4rem 0;
    border: 1px solid #e5ded2;
    border-radius: 18px;
    background: #fbfaf7;
    overflow: hidden;
  }

  .frame {
    overflow-x: auto;
    padding: 1rem;
    background: #f7f4ee;
  }

  img {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
  }

  figcaption {
    display: grid;
    gap: 0.25rem;
    padding: 0.75rem 1rem 0.9rem;
    color: #5f574c;
    font-size: 0.9rem;
    line-height: 1.45;
  }

  figcaption strong {
    color: #211f1b;
  }

  code {
    width: fit-content;
    border: 1px solid #e6dfd2;
    border-radius: 999px;
    padding: 0.1rem 0.45rem;
    background: #fff;
    color: #6b6257;
    font-size: 0.78rem;
  }
</style>
