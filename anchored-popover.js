"use strict";

(function exposeAnchoredPopover(root, factory) {
  const hasCommonJS = typeof module === "object" && module.exports;
  const core =
    root.BirdViewCore ||
    (hasCommonJS && typeof require === "function" ? require("./bird-view-core.js") : null);
  const popover = factory(core);
  if (hasCommonJS) module.exports = popover;
  root.BirdViewPopover = popover;
})(typeof globalThis === "object" ? globalThis : this, (core) => {
  const { clamp } = core;
  const EDGE_MARGIN = 8;
  const ANCHOR_GAP = 6;

  // Shared shell for the search-and-pick dialogs anchored to a media label: the
  // tag editor and the folder picker. Subclasses supply renderOptions and
  // handleKeyDown; placement, the keyboard cursor and dismissal live here so the
  // two cannot drift apart.
  class AnchoredPopover {
    constructor(options) {
      this.options = options;
      this.session = null;
    }

    mount(node, anchor, { className, ariaLabel, heading, placeholder, buttons = [], extra }) {
      const editor = document.createElement("div");
      const headingElement = document.createElement("div");
      const input = document.createElement("input");
      const options = document.createElement("div");
      const footer = document.createElement("div");
      const session = {
        node,
        anchor,
        editor,
        input,
        options,
        actions: [],
        activeIndex: 0,
        outsideHandler: null,
        ...extra,
      };

      editor.className = className;
      editor.setAttribute("role", "dialog");
      editor.setAttribute("aria-label", ariaLabel);
      headingElement.className = "tag-editor-heading";
      headingElement.textContent = heading;
      input.className = "tag-editor-search";
      input.type = "search";
      input.placeholder = placeholder;
      input.setAttribute("aria-label", placeholder);
      options.className = "tag-editor-options";
      footer.className = "tag-editor-footer";
      for (const { label, primary, onClick } of buttons) {
        const button = document.createElement("button");
        button.className = primary ? "tag-editor-button is-primary" : "tag-editor-button";
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => onClick(session));
        footer.append(button);
      }

      input.addEventListener("input", () => {
        session.activeIndex = 0;
        this.renderOptions(session);
      });
      input.addEventListener("keydown", (event) => this.handleKeyDown(event, session));
      editor.addEventListener("pointerdown", (event) => event.stopPropagation());
      editor.append(headingElement, input, options, footer);
      this.options.getViewport().append(editor);
      this.session = session;
      this.renderOptions(session);

      session.outsideHandler = (event) => {
        if (!editor.contains(event.target) && event.target !== anchor) this.close();
      };
      document.addEventListener("pointerdown", session.outsideHandler, true);
      requestAnimationFrame(() => {
        if (this.session !== session) return;
        this.position(session);
        input.focus();
      });
      return session;
    }

    getQuery(session) {
      return session.input.value.trim().toLocaleLowerCase();
    }

    resetOptions(session) {
      session.options.replaceChildren();
      session.actions = [];
    }

    appendAction(session, element, activate) {
      element.addEventListener("click", activate);
      session.options.append(element);
      session.actions.push({ element, activate });
    }

    appendEmptyMessage(session, message) {
      const empty = document.createElement("div");
      empty.className = "tag-editor-empty";
      empty.textContent = message;
      session.options.append(empty);
    }

    commitOptions(session) {
      session.activeIndex = clamp(session.activeIndex, 0, Math.max(0, session.actions.length - 1));
      this.updateSelection(session);
    }

    moveSelection(session, direction) {
      if (!session.actions.length) return;
      session.activeIndex =
        (session.activeIndex + direction + session.actions.length) % session.actions.length;
      this.updateSelection(session, true);
    }

    updateSelection(session, scroll = false) {
      for (const [index, action] of session.actions.entries()) {
        action.element.classList.toggle("is-active", index === session.activeIndex);
      }
      if (scroll) {
        session.actions[session.activeIndex]?.element.scrollIntoView({ block: "nearest" });
      }
    }

    position(session) {
      const viewportRect = this.options.getViewport().getBoundingClientRect();
      const anchorRect = session.anchor?.getBoundingClientRect() || {
        left: viewportRect.left + viewportRect.width / 2,
        top: viewportRect.top + viewportRect.height / 2,
        height: 0,
      };
      const width = session.editor.offsetWidth;
      const height = session.editor.offsetHeight;
      const anchorLeft = anchorRect.left - viewportRect.left;
      const anchorTop = anchorRect.top - viewportRect.top;
      const left = clamp(
        anchorLeft,
        EDGE_MARGIN,
        Math.max(EDGE_MARGIN, viewportRect.width - width - EDGE_MARGIN),
      );
      const below = anchorTop + anchorRect.height + ANCHOR_GAP;
      const top =
        below + height <= viewportRect.height - EDGE_MARGIN
          ? below
          : Math.max(EDGE_MARGIN, anchorTop - height - ANCHOR_GAP);
      session.editor.style.left = `${Math.round(left)}px`;
      session.editor.style.top = `${Math.round(top)}px`;
    }

    closeForNode(node) {
      if (this.session?.node === node) this.close();
    }

    close() {
      const session = this.session;
      if (!session) return;
      document.removeEventListener("pointerdown", session.outsideHandler, true);
      session.editor.remove();
      this.session = null;
    }
  }

  return Object.freeze({ AnchoredPopover });
});
