import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AudioClip, VideoClip } from '../../domain/model';

/** Wide enough to grab with a mouse, narrow enough to leave room to drag the clip body. */
const HANDLE_WIDTH_PX = 6;

const KIND_STYLES: Record<'video' | 'audio', { bg: string; border: string }> = {
  video: { bg: 'bg-[#2f5d8a]', border: 'border-[#4c9eff]' },
  audio: { bg: 'bg-[#2f7a5d]', border: 'border-[#4cffb0]' },
};

/** One clip, rendered as a labeled color block (no filmstrip/waveform — deferred from
 * Phase 3, docs/ROADMAP.md). Body drag moves the clip; the edge strips trim it. */
export function ClipBlock(props: {
  clip: VideoClip | AudioClip;
  label: string;
  left: number;
  width: number;
  height: number;
  selected: boolean;
  disabled: boolean;
  onBodyPointerDown: (e: ReactPointerEvent) => void;
  onHeadPointerDown: (e: ReactPointerEvent) => void;
  onTailPointerDown: (e: ReactPointerEvent) => void;
}) {
  const styles = KIND_STYLES[props.clip.type];

  return (
    <div
      data-testid="clip-block"
      data-clip-id={props.clip.id}
      className={`absolute top-1 flex items-center overflow-hidden rounded border text-[11px] text-fg ${styles.bg} ${
        props.selected ? 'border-accent ring-1 ring-accent' : styles.border
      } ${props.clip.enabled ? '' : 'opacity-40'}`}
      style={{
        left: props.left,
        width: Math.max(props.width, HANDLE_WIDTH_PX * 2),
        height: props.height,
      }}
      onPointerDown={props.onBodyPointerDown}
    >
      <div
        data-testid="clip-trim-head"
        className="h-full shrink-0 cursor-ew-resize"
        style={{ width: HANDLE_WIDTH_PX }}
        onPointerDown={(e) => {
          e.stopPropagation();
          props.onHeadPointerDown(e);
        }}
      />
      <span className="flex-1 truncate px-1 select-none">{props.label}</span>
      <div
        data-testid="clip-trim-tail"
        className="h-full shrink-0 cursor-ew-resize"
        style={{ width: HANDLE_WIDTH_PX }}
        onPointerDown={(e) => {
          e.stopPropagation();
          props.onTailPointerDown(e);
        }}
      />
    </div>
  );
}
