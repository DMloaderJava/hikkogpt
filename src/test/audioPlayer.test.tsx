import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { AudioPlayer } from "@/components/AudioPlayer";
import { STOP_SPEECH_EVENT } from "@/lib/speechEvents";

/**
 * AudioPlayer общий для «Озвучки диалога», сообщений чата и озвучивателя манги,
 * поэтому автозапуск и реакция на глобальный «стоп» покрыты отдельно.
 */

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock") as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AudioPlayer", () => {
  it("по умолчанию запускается сам (поведение «Озвучки диалога» не изменилось)", () => {
    const { container } = render(<AudioPlayer src="blob:a" />);
    expect(container.querySelector("audio")!.hasAttribute("autoplay")).toBe(true);
  });

  it("autoPlay={false} не запускает воспроизведение при монтировании", () => {
    const { container } = render(<AudioPlayer src="blob:a" autoPlay={false} />);
    expect(container.querySelector("audio")!.hasAttribute("autoplay")).toBe(false);
  });

  it("глобальный стоп ставит играющий плеер на паузу", () => {
    const { container } = render(<AudioPlayer src="blob:a" autoPlay={false} />);
    const audio = container.querySelector("audio")!;
    const pause = vi.fn();
    Object.defineProperty(audio, "paused", { value: false, configurable: true });
    audio.pause = pause;

    act(() => {
      window.dispatchEvent(new Event(STOP_SPEECH_EVENT));
    });

    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("остановленный плеер не дёргается на повторный стоп", () => {
    const { container } = render(<AudioPlayer src="blob:a" autoPlay={false} />);
    const audio = container.querySelector("audio")!;
    const pause = vi.fn();
    Object.defineProperty(audio, "paused", { value: true, configurable: true });
    audio.pause = pause;

    act(() => {
      window.dispatchEvent(new Event(STOP_SPEECH_EVENT));
    });

    expect(pause).not.toHaveBeenCalled();
  });

  it("после размонтирования событие не обрабатывается", () => {
    const { container, unmount } = render(<AudioPlayer src="blob:a" autoPlay={false} />);
    const audio = container.querySelector("audio")!;
    const pause = vi.fn();
    Object.defineProperty(audio, "paused", { value: false, configurable: true });
    audio.pause = pause;

    unmount();
    act(() => {
      window.dispatchEvent(new Event(STOP_SPEECH_EVENT));
    });

    expect(pause).not.toHaveBeenCalled();
  });

  it("ссылка на скачивание ведёт на озвучку с именем файла", () => {
    const { container } = render(<AudioPlayer src="blob:page-1" fileName="manga-page-1.wav" />);
    const link = container.querySelector("a[download]")!;
    expect(link.getAttribute("href")).toBe("blob:page-1");
    expect(link.getAttribute("download")).toBe("manga-page-1.wav");
  });
});
