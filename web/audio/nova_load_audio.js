/**
 * nova_load_audio.js — upload button + inline preview for the Nova Load Audio node.
 *
 * Why this file exists
 * --------------------
 * ComfyUI's built-in audio upload button is NOT generic. In the frontend
 * (comfyui_frontend_package 1.45.x, src/extensions/core/uploadAudio.ts):
 *
 *   Comfy.UploadAudio  fires only when  nodeData.input.required.audio[1].audio_upload === true
 *                      i.e. the input must literally be named "audio";
 *                      it then looks up  node.widgets.find(w => w.name === "audioUI").
 *
 *   Comfy.AudioWidget  is what creates that "audioUI" widget — but only for a
 *                      hardcoded list of core classes:
 *                      LoadAudio, SaveAudio, PreviewAudio, SaveAudioMP3,
 *                      SaveAudioOpus, SaveAudioAdvanced.
 *
 * A custom class is never in that list, so setting audio_upload:true on a custom
 * node makes AUDIOUPLOAD run with audioUI === undefined and throw inside
 * updateUIWidget (`audioUIWidget.element.src = url`), losing the button anyway.
 * Declaring audioUI from Python is not a fix either: the AUDIO_UI widget sets
 * serialize=false, so the prompt never carries it and a *required* audioUI makes
 * the backend reject every run with "Required input is missing"; an *optional*
 * one is created after the injected upload widget and so is still undefined when
 * AUDIOUPLOAD looks for it.
 *
 * So this node owns its upload widget outright — the same approach VideoHelper-
 * Suite takes — and depends on no hardcoded core names.
 */

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_CLASS = "NovaLoadAudio";
const FILE_WIDGET = "audio";
const SENTINEL_RE = /^\s*\(no audio files/;

/** "sub/song.wav [input]" -> /view?filename=song.wav&subfolder=sub&type=input */
function viewURL(value) {
  if (!value || SENTINEL_RE.test(value)) return "";
  let name = String(value).trim();
  let type = "input";
  const annotated = /^(.*)\[(.*)\]$/.exec(name);
  if (annotated) {
    name = annotated[1].trim();
    type = annotated[2].trim();
  }
  let subfolder = "";
  const cut = name.lastIndexOf("/");
  if (cut > -1) {
    subfolder = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  const q = new URLSearchParams({ filename: name, subfolder, type });
  return api.apiURL(`/view?${q}`);
}

function setupNovaLoadAudio(node) {
  const fileWidget = node.widgets?.find((w) => w.name === FILE_WIDGET);
  if (!fileWidget) return;

  // ---- inline preview player -------------------------------------------
  const player = document.createElement("audio");
  player.controls = true;
  player.preload = "none";
  player.style.width = "100%";
  player.classList.add("comfy-audio");

  const preview = node.addDOMWidget("nova_audio_preview", "audiopreview", player, {
    serialize: false,
  });
  preview.serialize = false;
  if (preview.options) preview.options.serialize = false;

  const refreshPreview = () => {
    const url = viewURL(fileWidget.value);
    if (url) player.src = url;
    else player.removeAttribute("src");
  };

  const previousCallback = fileWidget.callback;
  fileWidget.callback = function (...args) {
    const result = previousCallback?.apply(this, args);
    refreshPreview();
    return result;
  };
  refreshPreview();

  // ---- hidden file input ------------------------------------------------
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "audio/*";
  picker.style.display = "none";
  document.body.append(picker);

  const previousOnRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    picker.remove();
    return previousOnRemoved?.apply(this, args);
  };

  const upload = async (file) => {
    if (!file) return;
    if (node.__novaUploading) return;
    node.__novaUploading = true;
    const previousValue = fileWidget.value;
    try {
      const body = new FormData();
      body.append("image", file); // /upload/image is the endpoint core audio uses too
      const resp = await api.fetchApi("/upload/image", { method: "POST", body });
      if (resp.status !== 200) {
        alert(`Nova Load Audio — upload failed: ${resp.status} ${resp.statusText}`);
        fileWidget.value = previousValue;
        return;
      }
      const data = await resp.json();
      let path = data.name;
      if (data.subfolder) path = `${data.subfolder}/${path}`;

      const values = fileWidget.options?.values;
      if (Array.isArray(values)) {
        // Drop the "(no audio files ...)" placeholder the node ships when the
        // input folder was empty at server start.
        if (values.length === 1 && SENTINEL_RE.test(values[0])) values.length = 0;
        if (!values.includes(path)) values.push(path);
      }

      fileWidget.value = path;
      fileWidget.callback?.(path);
      node.onWidgetChanged?.(fileWidget.name, path, previousValue, fileWidget);
      node.graph?.setDirtyCanvas(true, true);
    } catch (err) {
      console.error("[Nova Load Audio] upload failed", err);
      fileWidget.value = previousValue;
    } finally {
      node.__novaUploading = false;
    }
  };

  picker.onchange = async () => {
    if (picker.files?.length) await upload(picker.files[0]);
    picker.value = "";
  };

  // ---- the button -------------------------------------------------------
  const button = node.addWidget("button", "upload_audio", "", () => picker.click(), {
    serialize: false,
  });
  button.label = "choose audio file to upload";

  // ---- drag & drop onto the node ---------------------------------------
  const previousOnDragOver = node.onDragOver;
  node.onDragOver = function (e) {
    if (e?.dataTransfer?.items) {
      return [...e.dataTransfer.items].some(
        (i) => i.kind === "file" && (i.type.startsWith("audio/") || i.type === "")
      );
    }
    return previousOnDragOver?.apply(this, arguments) ?? false;
  };
  const previousOnDragDrop = node.onDragDrop;
  node.onDragDrop = function (e) {
    const files = [...(e?.dataTransfer?.files ?? [])];
    const audio = files.find((f) => f.type.startsWith("audio/") || f.type === "");
    if (audio) {
      upload(audio);
      return true;
    }
    return previousOnDragDrop?.apply(this, arguments) ?? false;
  };
}

app.registerExtension({
  name: "Nova.LoadAudio.Upload",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = onNodeCreated?.apply(this, args);
      // Never let a frontend API change break node creation itself.
      try {
        setupNovaLoadAudio(this);
      } catch (err) {
        console.error("[Nova Load Audio] could not build upload widget", err);
      }
      return result;
    };
  },
});
