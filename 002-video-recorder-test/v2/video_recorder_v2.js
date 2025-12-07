document.addEventListener("DOMContentLoaded", () => {
  const elem = document.getElementById("libVersion")
  if (elem) {
    elem.innerText = "2025/11/22 15:00 (v2: Optimized)"
  }
})

window.MyVideoRecorder = (() => {
  // 定数定義
  const CONSTANTS = {
    VIDEO_BITS_PER_SECOND: 800000,
    AUDIO_BITS_PER_SECOND: 128000,
    DEFAULT_LONG_SIDE: 640,
    DEFAULT_SHORT_SIDE: 360,
    MIME_TYPES: [
      "video/mp4;codecs:h264,aac",
      "video/mp4;codecs:h264",
      "video/mp4",
      "video/webm;codecs:vp9,opus",
      "video/webm;codecs:vp8,opus",
      "video/webm"
    ]
  };

  /**
   * --------------------------------------------------------------------------
   * 1. StreamStore (Multiton)
   * 制約(Constraints)ごとにストリームを管理する。
   * 異なるデバイスIDや解像度を要求する場合、別々のストリームとして扱われるため
   * 他のレコーダーへの副作用が発生しない。
   * --------------------------------------------------------------------------
   */
  const StreamStore = {
    // Key: JSON.stringify(constraints), Value: { stream: MediaStream, subscribers: Set<Object> }
    entries: new Map(),
    
    // どのレコーダーがどのキーのストリームを使っているか（クリーンアップ用）
    // Key: requester, Value: constraintsKey
    requesterMap: new Map(),

    hasPermission: false,

    /**
     * ストリームを要求する
     * @param {Object} requester - 要求元のインスタンス
     * @param {MediaStreamConstraints} constraints - 要求する制約
     */
    async requestStream(requester, constraints) {
      // 1. 以前の購読があれば解除する（切り替え処理）
      this.releaseStream(requester);

      const key = JSON.stringify(constraints);
      
      // 2. 既存のストリームがあればそれを返す（共有）
      if (this.entries.has(key)) {
        const entry = this.entries.get(key);
        entry.subscribers.add(requester);
        this.requesterMap.set(requester, key);
        return entry.stream;
      }

      // 3. 新規取得
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // エントリ作成
        this.entries.set(key, {
          stream: stream,
          subscribers: new Set([requester])
        });
        this.requesterMap.set(requester, key);
        this.hasPermission = true;
        
        return stream;
      } catch (err) {
        console.error("StreamStore: getUserMedia failed", err);
        throw err;
      }
    },

    /**
     * ストリームの利用を終了する
     * @param {Object} requester 
     */
    releaseStream(requester) {
      const key = this.requesterMap.get(requester);
      if (!key) return; // 購読していない

      const entry = this.entries.get(key);
      if (entry) {
        entry.subscribers.delete(requester);
        
        // 購読者がいなくなったらストリームを停止・破棄
        if (entry.subscribers.size === 0) {
          entry.stream.getTracks().forEach(t => t.stop());
          this.entries.delete(key);
        }
      }
      
      this.requesterMap.delete(requester);
    },

    /**
     * 権限状態の確認
     */
    async checkPermissions() {
      try {
        if (!navigator.permissions || !navigator.permissions.query) return false;
        const camState = await navigator.permissions.query({ name: "camera" }).catch(() => ({ state: "prompt" }));
        const micState = await navigator.permissions.query({ name: "microphone" }).catch(() => ({ state: "prompt" }));
        this.hasPermission = (camState.state === "granted" && micState.state === "granted");
        return this.hasPermission;
      } catch {
        return false;
      }
    },

    /**
     * 権限の取得（ダイアログ表示）
     */
    async ensurePermissions() {
      if (this.hasPermission) return true;

      let probeStream = null;
      try {
        probeStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        this.hasPermission = true;
        return true;
      } catch (err) {
        console.error("StreamStore: Permission denied", err);
        return false;
      } finally {
        if (probeStream) {
          probeStream.getTracks().forEach(t => t.stop());
        }
      }
    },

    /**
     * 利用可能なデバイス一覧の取得
     */
    async getAvailableDevices() {
      if (!await this.ensurePermissions()) {
        return { success: false, videoDevices: [], audioDevices: [] };
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const filterAndMap = (kind) =>
          devices.filter(d => d.kind === kind).map(d => ({ id: d.deviceId, label: d.label }));

        const videoDevices = filterAndMap("videoinput");
        const audioDevices = filterAndMap("audioinput");

        const DEFAULT_VIDEO = { id: "", label: "デフォルトのカメラ" };
        const DEFAULT_AUDIO = { id: "", label: "デフォルトのマイク" };

        const withDefault = (list, def) =>
          list.some(d => d.id === def.id) ? list : [def, ...list];

        return {
          success: true,
          videoDevices: withDefault(videoDevices, DEFAULT_VIDEO),
          audioDevices: withDefault(audioDevices, DEFAULT_AUDIO)
        };
      } catch (err) {
        console.error("StreamStore: enumerateDevices failed", err);
        return { success: false, videoDevices: [], audioDevices: [] };
      }
    },
    
    isMediaDeviceSupported() {
      return !!(navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function" &&
        typeof navigator.mediaDevices.enumerateDevices === "function");
    }
  };

  /**
   * --------------------------------------------------------------------------
   * 2. CanvasRenderer
   * 映像の描画、アスペクト比計算、回転処理を担当
   * --------------------------------------------------------------------------
   */
  class CanvasRenderer {
    constructor(videoElement, canvasElement) {
      this.videoElement = videoElement;
      this.canvasElement = canvasElement;
      this.ctx = canvasElement.getContext("2d");
      this.animationFrameId = null;
      this.stream = null;
      
      // 設定値
      this.longSide = CONSTANTS.DEFAULT_LONG_SIDE;
      this.shortSide = CONSTANTS.DEFAULT_SHORT_SIDE;
      
      // 状態
      this.videoPreviewAspectRatio = 0;
    }

    /**
     * 描画ループの開始
     * @param {MediaStream} stream 
     */
    start(stream) {
      this.stream = stream;
      this.videoElement.srcObject = stream;
      this.videoElement.style.opacity = "0"; // 初期化中は隠す
      
      // メタデータ読み込み待ち
      return new Promise((resolve) => {
        const onLoaded = () => {
          this.videoElement.removeEventListener("loadedmetadata", onLoaded);
          this.videoElement.style.opacity = "1";
          this.drawFrame();
          resolve();
        };
        
        if (this.videoElement.readyState >= 1) {
          onLoaded();
        } else {
          this.videoElement.addEventListener("loadedmetadata", onLoaded);
        }
      });
    }

    stop() {
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      this.videoElement.srcObject = null;
      this.stream = null;
    }

    /**
     * アスペクト比を計算し、Canvasサイズを決定する
     * @param {boolean} isPortraitMode - アプリケーションが期待する向き（縦長かどうか）
     * @returns {Promise<void>}
     */
    async calculateAspectRatio(isPortraitMode) {
      return new Promise((resolve) => {
        // 現在のサイズで比率を計算
        let aspect = this.videoElement.videoWidth / this.videoElement.videoHeight;

        // 「縦画面モードなのに、映像が横長」の場合は、回転適用待ちの可能性が高いので少し待つ
        if (isPortraitMode && aspect > 1) {
          setTimeout(() => {
            this.videoPreviewAspectRatio = this.videoElement.videoWidth / this.videoElement.videoHeight;
            resolve();
          }, 500);
        } else {
          this.videoPreviewAspectRatio = aspect;
          resolve();
        }
      });
    }

    /**
     * 期待する向きと実際の映像の向きが逆転しているかチェック
     */
    isInverted(isPortraitMode) {
      const reqPortraitAndGetLandscape = isPortraitMode && this.videoPreviewAspectRatio > 1;
      const reqLandscapeAndGetPortrait = !isPortraitMode && this.videoPreviewAspectRatio < 1;
      return reqPortraitAndGetLandscape || reqLandscapeAndGetPortrait;
    }

    /**
     * Canvasのサイズを設定
     */
    updateCanvasSize() {
      const isPortraitStream = this.videoPreviewAspectRatio < 1;
      const canvasAspectRatio = isPortraitStream ? 9 / 16 : 16 / 9;

      let width, height;
      if (isPortraitStream) {
        height = this.longSide;
        width = height * canvasAspectRatio;
      } else {
        width = this.longSide;
        height = width / canvasAspectRatio;
      }
      this.canvasElement.width = width;
      this.canvasElement.height = height;
    }

    drawFrame() {
      if (!this.stream) return;

      const videoWidth = this.videoElement.videoWidth;
      const videoHeight = this.videoElement.videoHeight;
      const canvasWidth = this.canvasElement.width;
      const canvasHeight = this.canvasElement.height;

      // アスペクト比を保持しながらフィット(カバーモード)
      const videoAspect = videoWidth / videoHeight;
      const canvasAspect = canvasWidth / canvasHeight;

      let drawWidth, drawHeight, x, y;

      if (videoAspect > canvasAspect) {
        // ビデオが横長の場合、高さに合わせて横幅を調整
        drawHeight = canvasHeight;
        drawWidth = drawHeight * videoAspect;
        x = (canvasWidth - drawWidth) / 2;
        y = 0;
      } else {
        // ビデオが縦長の場合、幅に合わせて高さを調整
        drawWidth = canvasWidth;
        drawHeight = drawWidth / videoAspect;
        x = 0;
        y = (canvasHeight - drawHeight) / 2;
      }

      this.ctx.drawImage(this.videoElement, x, y, drawWidth, drawHeight);
      this.animationFrameId = requestAnimationFrame(() => this.drawFrame());
    }
    
    captureStream(fps) {
      return this.canvasElement.captureStream(fps);
    }
  }

  /**
   * --------------------------------------------------------------------------
   * 3. RecorderEngine
   * MediaRecorderのラッパー
   * --------------------------------------------------------------------------
   */
  class RecorderEngine {
    constructor() {
      this.mediaRecorder = null;
      this.recordedChunks = [];
      this.isRecording = false;
      this.mimeType = "video/webm";
    }

    start(canvasStream, audioTrack) {
      if (this.isRecording) return false;

      this.recordedChunks = [];
      
      // 音声トラックの追加
      if (audioTrack) {
        canvasStream.addTrack(audioTrack);
      }

      // MIMEタイプの決定
      const options = {
        videoBitsPerSecond: CONSTANTS.VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: CONSTANTS.AUDIO_BITS_PER_SECOND
      };
      
      for (const type of CONSTANTS.MIME_TYPES) {
        if (MediaRecorder.isTypeSupported(type)) {
          options.mimeType = type;
          break;
        }
      }
      this.mimeType = options.mimeType || "video/webm";

      try {
        this.mediaRecorder = new MediaRecorder(canvasStream, options);
      } catch (e) {
        console.error("MediaRecorder init failed", e);
        return false;
      }

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.start(100); // 100msごとにチャンク生成
      this.isRecording = true;
      return true;
    }

    stop() {
      return new Promise((resolve) => {
        if (!this.mediaRecorder || !this.isRecording) {
          return resolve({ blob: null, mimeType: null });
        }

        this.mediaRecorder.onstop = (event) => {
          const blob = new Blob(this.recordedChunks, { type: this.mimeType });
          this.isRecording = false;
          this.recordedChunks = [];
          
          // クリーンアップ
          event.target.onstop = null;
          event.target.ondataavailable = null;
          
          resolve({ blob, mimeType: this.mimeType });
        };

        this.mediaRecorder.stop();
      });
    }
  }

  /**
   * --------------------------------------------------------------------------
   * 4. VideoRecorder (Facade)
   * ユーザーインターフェースと各モジュールの調整役
   * --------------------------------------------------------------------------
   */
  class VideoRecorder {
    constructor(videoElement, canvasElement, logTextArea) {
      this.renderer = new CanvasRenderer(videoElement, canvasElement);
      this.engine = new RecorderEngine();
      this.logTextArea = logTextArea;

      // 設定
      this.config = {
        videoDeviceId: "",
        audioDeviceId: "",
        videoWidth: null,
        videoHeight: null
      };

      // 状態
      this.isPreviewing = false;
      this.isPortraitCamera = false;
    }

    async init() {
      // カメラサポート確認
      this.cameraSupported = StreamStore.isMediaDeviceSupported() && await StreamStore.checkPermissions();
      // 権限確認（ここではチェックのみ）
      await StreamStore.checkPermissions();
    }

    log(msg) {
      if (!this.logTextArea) return;
      const t = new Date().toLocaleTimeString();
      this.logTextArea.value += `${t} ${msg}\n`;
    }

    /**
     * プレビュー開始（カメラ起動）
     * @param {boolean} isRetry - リトライ呼び出しかどうか
     */
    async startPreview(isRetry = false) {
      // 録画中なら停止
      if (this.engine.isRecording) {
        await this.stopRecording();
      }
      
      // 既存プレビュー停止（ただしストリームの完全解放はStreamStoreに任せる）
      if (this.isPreviewing && !isRetry) {
        this.stopPreview();
      }

      try {
        // 1. 画面サイズから要求するアスペクト比を決定
        const windowAspectRatio = window.innerWidth / window.innerHeight;
        const isSmallerThan768px = window.innerWidth < 768;
        this.isPortraitCamera = isSmallerThan768px && windowAspectRatio < 1;

        // 2. 制約の作成
        let width = this.config.videoWidth;
        let height = this.config.videoHeight;
        
        // 指定がなければデフォルト値
        if (!width || !height) {
          width = this.isPortraitCamera ? CONSTANTS.DEFAULT_SHORT_SIDE : CONSTANTS.DEFAULT_LONG_SIDE;
          height = this.isPortraitCamera ? CONSTANTS.DEFAULT_LONG_SIDE : CONSTANTS.DEFAULT_SHORT_SIDE;
        }
        
        // リトライ時は縦横を入れ替えて要求する
        if (isRetry) {
          [width, height] = [height, width];
        }

        const constraints = {
          video: {
            width: { ideal: width },
            height: { ideal: height },
            frameRate: { ideal: 30, max: 30 },
            facingMode: "user"
          },
          audio: {
            echoCancellation: { ideal: true },
            noiseSuppression: { ideal: true },
            autoGainControl: { ideal: true },
            sampleRate: { ideal: 48000 },
            channelCount: { ideal: 1 }
          }
        };

        if (this.config.videoDeviceId) {
          constraints.video.deviceId = { exact: this.config.videoDeviceId };
        }
        if (this.config.audioDeviceId) {
          constraints.audio.deviceId = { exact: this.config.audioDeviceId };
        }

        // 3. ストリーム取得
        const stream = await StreamStore.requestStream(this, constraints);
        
        // 4. レンダラー開始
        await this.renderer.start(stream);
        
        // 5. アスペクト比チェックと補正
        await this.renderer.calculateAspectRatio(this.isPortraitCamera);
        
        const isInverted = this.renderer.isInverted(this.isPortraitCamera);
        const logMsg = `Req: ${width}x${height}, PortraitMode: ${this.isPortraitCamera}, ActualAspect: ${this.renderer.videoPreviewAspectRatio.toFixed(2)}`;
        
        if (isInverted && !isRetry) {
          this.log(`VH Retry: ${logMsg}`);
          // ストリームを一度手放してリトライ
          StreamStore.releaseStream(this);
          return this.startPreview(true);
        } else {
          this.log(`VH Fixed: ${logMsg}`);
        }

        // 6. Canvasサイズ確定
        this.renderer.updateCanvasSize();
        
        this.isPreviewing = true;
        return true;

      } catch (err) {
        console.error("startPreview failed", err);
        this.log(`Error: ${err.message}`);
        this.stopPreview();
        return false;
      }
    }

    stopPreview() {
      this.renderer.stop();
      StreamStore.releaseStream(this);
      this.isPreviewing = false;
    }

    startRecording(options) {
      if (!this.isPreviewing) {
        console.error("Preview not started");
        return false;
      }
      
      const canvasStream = this.renderer.captureStream(30);
      // 現在使用中のストリームから音声トラックを取得
      // StreamStoreは複数のストリームを持っているので、this(requester)が使っているストリームを特定する必要があるが、
      // renderer.stream がまさにそれである。
      const audioTracks = this.renderer.stream ? this.renderer.stream.getAudioTracks() : [];
      
      // 録画開始
      const success = this.engine.start(canvasStream, audioTracks[0]);
      
      // コールバック設定（サイズ通知など）
      if (success && options && options.onProcess) {
        const interval = setInterval(() => {
          if (!this.engine.isRecording) {
            clearInterval(interval);
            return;
          }
          const totalSize = this.engine.recordedChunks.reduce((acc, chunk) => acc + chunk.size, 0);
          options.onProcess({ totalSize });
        }, 500);
      }
      
      return success;
    }

    async stopRecording() {
      return this.engine.stop();
    }

    // デバイス変更時の処理
    async updateDevice(type, deviceId) {
      if (type === 'video') this.config.videoDeviceId = deviceId;
      if (type === 'audio') this.config.audioDeviceId = deviceId;

      // プレビュー中なら再起動して反映
      if (this.isPreviewing) {
        await this.startPreview();
      }
    }
  }

  // --- 公開用ファクトリ関数 ---

  const writeHtml = (elem, messageForUnsupported) => {
    elem.innerHTML = `
     <video autoplay playsinline muted style="width: 100%; object-fit: contain; transform: scaleX(-1)">
       <p></p>
     </video>
     <canvas style="display:none;"></canvas>
   `;
    const video = elem.querySelector("video");
    const p = video.querySelector("p");
    p.innerHTML = messageForUnsupported || "Video Not Supported";
    const canvas = elem.querySelector("canvas");
    return { video, canvas };
  };

  const createVideoObject = async ({ elems, logTextArea }) => {
    const vr = new VideoRecorder(elems.video, elems.canvas, logTextArea);
    await vr.init();

    // 外部公開インターフェース（既存互換）
    return {
      get cameraSupported() { return StreamStore.isMediaDeviceSupported(); },
      ensurePermissions: () => StreamStore.ensurePermissions(),
      startPreview: () => vr.startPreview(),
      stopPreview: () => vr.stopPreview(),
      getAvailableDevices: () => StreamStore.getAvailableDevices(),
      startRecording: (opts) => vr.startRecording(opts),
      stopRecording: () => vr.stopRecording(),
      
      get videoDevice() { return vr.config.videoDeviceId; },
      set videoDevice(value) { vr.updateDevice('video', value); },
      
      get audioDevice() { return vr.config.audioDeviceId; },
      set audioDevice(value) { vr.updateDevice('audio', value); }
    };
  };

  const init = async ({ selector, messageForUnsupported, logTextArea }) => {
    let elems;
    if (selector instanceof HTMLElement) {
      elems = writeHtml(selector, messageForUnsupported);
    } else if (typeof selector === "string") {
      const elem = document.querySelector(selector);
      if (!elem) throw new Error("element not found: " + selector);
      elems = writeHtml(elem, messageForUnsupported);
    } else {
      throw new Error("invalid selector: " + selector);
    }
    return createVideoObject({ elems, logTextArea });
  };

  return { init };
})();
