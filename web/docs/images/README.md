# Shared images for the node help pages

The ComfyUI frontend serves this whole tree at

    /extensions/comfyui-novaaudioplayer/docs/

and resolves every relative image in an `en.md` against that ROOT — not against
the folder the `en.md` sits in. So from any node's page:

    ![alt](images/name.png)      ->  .../docs/images/name.png     works
    ![alt](name.png)             ->  .../docs/name.png            404s

That is why images live here rather than beside each page: one file can be
referenced by several nodes, which is what you want when two nodes share a
screenshot of the same chain.

Verified against frontend 1.45.15 — `nodeHelpUtil.ts` builds the baseUrl,
`markdownRendererUtil.ts` prefixes relative hrefs with it.

`<video>` / `<source>` are also permitted, with controls, autoplay, loop,
muted, preload and poster.

Keep names lowercase and hyphenated: `tag-chain.png`, `nova-console.png`.
