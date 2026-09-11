import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { useCameraStream } from "@/hooks/useCameraStream";
import { CameraBottomSheet } from "@/components/CameraBottomSheet";

// --- Моки браузерных API, которых нет в jsdom ---

class FakeTrack {
  stopped = false;
  constraints: MediaTrackConstraints | null = null;
  kind = "video";
  stop() {
    this.stopped = true;
  }
  getCapabilities(): MediaTrackCapabilities {
    return {} as MediaTrackCapabilities;
  }
  applyConstraints(constraints: MediaTrackConstraints): Promise<void> {
    this.constraints = constraints;
    return Promise.resolve();
  }
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = [new FakeTrack()]) {
    this.tracks = tracks;
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

function mockGetUserMedia(impl: (constraints: MediaStreamConstraints) => Promise<unknown>) {
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn(impl) },
    configurable: true,
    writable: true,
  });
}

function clearMediaDevices() {
  Object.defineProperty(navigator, "mediaDevices", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  if (typeof window.HTMLMediaElement !== "undefined" && !window.HTMLMediaElement.prototype.play) {
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  } else if (typeof window.HTMLMediaElement !== "undefined") {
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  }
  if (typeof window.ResizeObserver === "undefined") {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useCameraStream", () => {
  it("успешно стартует поток и отдаёт granted", async () => {
    const stream = new FakeStream();
    mockGetUserMedia(() => Promise.resolve(stream));

    const { result } = renderHook(() => useCameraStream({ enabled: true, facing: "environment" }));

    await waitFor(() => {
      expect(result.current.permission).toBe("granted");
    });
    expect(result.current.stream).toBe(stream);
    expect(result.current.error).toBeNull();
  });

  it("останавливает все треки при enabled=false (зелёная точка гаснет)", async () => {
    const track = new FakeTrack();
    mockGetUserMedia(() => Promise.resolve(new FakeStream([track])));

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useCameraStream({ enabled, facing: "environment" }),
      { initialProps: { enabled: true } }
    );

    await waitFor(() => {
      expect(result.current.permission).toBe("granted");
    });
    expect(track.stopped).toBe(false);

    rerender({ enabled: false });

    await waitFor(() => {
      expect(track.stopped).toBe(true);
    });
    expect(result.current.stream).toBeNull();
  });

  it("останавливает треки при размонтировании", async () => {
    const track = new FakeTrack();
    mockGetUserMedia(() => Promise.resolve(new FakeStream([track])));

    const { result, unmount } = renderHook(() =>
      useCameraStream({ enabled: true, facing: "environment" })
    );

    await waitFor(() => {
      expect(result.current.permission).toBe("granted");
    });

    unmount();
    expect(track.stopped).toBe(true);
  });

  it("маппит NotAllowedError в denied с понятным текстом", async () => {
    const err = new DOMException("Permission denied", "NotAllowedError");
    mockGetUserMedia(() => Promise.reject(err));

    const { result } = renderHook(() => useCameraStream({ enabled: true, facing: "environment" }));

    await waitFor(() => {
      expect(result.current.permission).toBe("denied");
    });
    expect(result.current.error).toBe("Доступ к камере запрещен");
    expect(result.current.stream).toBeNull();
  });

  it("возвращает unsupported без getUserMedia", async () => {
    clearMediaDevices();

    const { result } = renderHook(() => useCameraStream({ enabled: true, facing: "environment" }));

    await waitFor(() => {
      expect(result.current.permission).toBe("unsupported");
    });
  });

  it("переключает facing user/environment", async () => {
    mockGetUserMedia(() => Promise.resolve(new FakeStream()));

    const { result } = renderHook(() => useCameraStream({ enabled: true, facing: "environment" }));

    await waitFor(() => {
      expect(result.current.permission).toBe("granted");
    });
    expect(result.current.facing).toBe("environment");

    act(() => {
      result.current.toggleFacing();
    });
    expect(result.current.facing).toBe("user");
  });

  it("capturePhoto возвращает null без активного видео", async () => {
    mockGetUserMedia(() => Promise.resolve(new FakeStream()));
    const { result } = renderHook(() => useCameraStream({ enabled: false, facing: "environment" }));
    // Без потока и video-элемента — null, а не исключение
    await expect(result.current.capturePhoto(0.8)).resolves.toBeNull();
  });

  it("capturePhoto возвращает Blob + object URL, а не base64", async () => {
    mockGetUserMedia(() => Promise.resolve(new FakeStream()));
    const jpegBlob = new Blob(["fake-jpeg"], { type: "image/jpeg" });
    URL.createObjectURL = vi.fn(() => "blob:mock-photo") as typeof URL.createObjectURL;

    const fakeCtx = { translate: vi.fn(), scale: vi.fn(), drawImage: vi.fn(), setTransform: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      fakeCtx as unknown as CanvasRenderingContext2D
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(jpegBlob);
    });

    let capture: (() => Promise<unknown>) | null = null;
    function Harness() {
      const hook = useCameraStream({ enabled: true, facing: "environment" });
      capture = () => hook.capturePhoto(0.8);
      return <video ref={hook.videoRef} data-testid="harness-video" />;
    }
    render(<Harness />);
    const video = (await screen.findByTestId("harness-video")) as HTMLVideoElement;
    Object.defineProperty(video, "videoWidth", { value: 1280, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 720, configurable: true });

    const photo = (await capture!()) as { blob: Blob; url: string };
    expect(photo.blob).toBe(jpegBlob);
    expect(photo.url).toBe("blob:mock-photo");
    expect(URL.createObjectURL).toHaveBeenCalledWith(jpegBlob);
  });
});

describe("CameraBottomSheet", () => {
  it("не рендерит контент шторки когда закрыта", () => {
    render(<CameraBottomSheet open={false} onOpenChange={() => {}} onCapture={() => {}} />);
    expect(screen.queryByTestId("camera-sheet")).toBeNull();
  });

  it("показывает заглушку unsupported без getUserMedia", async () => {
    clearMediaDevices();
    render(<CameraBottomSheet open={true} onOpenChange={() => {}} onCapture={() => {}} />);

    expect(await screen.findByTestId("camera-sheet")).toBeTruthy();
    expect(await screen.findByText("Камера не поддерживается в этом браузере")).toBeTruthy();
  });

  it("показывает заглушку denied с кнопкой повтора", async () => {
    const err = new DOMException("Denied", "NotAllowedError");
    mockGetUserMedia(() => Promise.reject(err));
    render(<CameraBottomSheet open={true} onOpenChange={() => {}} onCapture={() => {}} />);

    expect(await screen.findByText("Камера недоступна")).toBeTruthy();
    expect(await screen.findByText("Доступ к камере запрещен")).toBeTruthy();
    expect(screen.getByText("Попробовать снова")).toBeTruthy();
  });

  it("кнопка закрытия вызывает onOpenChange(false)", async () => {
    clearMediaDevices();
    const onOpenChange = vi.fn();
    render(<CameraBottomSheet open={true} onOpenChange={onOpenChange} onCapture={() => {}} />);

    const closeBtn = await screen.findByText("Закрыть");
    fireEvent.click(closeBtn);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("рендерит видео, затвор и переключатель при granted", async () => {
    mockGetUserMedia(() => Promise.resolve(new FakeStream()));
    render(<CameraBottomSheet open={true} onOpenChange={() => {}} onCapture={() => {}} />);

    expect(await screen.findByTestId("camera-video")).toBeTruthy();
    expect(await screen.findByLabelText("Сделать фото")).toBeTruthy();
    expect(screen.getByLabelText("Переключить камеру")).toBeTruthy();
    expect(screen.getByLabelText("Закрыть камеру")).toBeTruthy();
  });
});
