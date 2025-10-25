document.addEventListener("DOMContentLoaded", () => {
  const elem = document.getElementById("libVersion")
  if (elem) {
    elem.innerText = "2025/10/25 16:00"
  }
})

window.MyVideoRecorder = (() => {

  const videoBitsPerSecond = 800000
  const audioBitsPerSecond = 128000

  // 同時に複数のカメラプレビューを動かさないためのグローバル管理
  // iOS Safari などで複数ストリームを同時起動すると向きやアスペクトが不安定になるため
  // 同一ページで script が複数回評価されても共有されるように window に保持
  const g = (typeof window !== 'undefined') ? window : globalThis;
  if (g.__IM_ACTIVE_VIDEO_RECORDER === undefined) {
    g.__IM_ACTIVE_VIDEO_RECORDER = null;
  }
  const getActiveRecorder = () => g.__IM_ACTIVE_VIDEO_RECORDER;
  const setActiveRecorder = (rec) => { g.__IM_ACTIVE_VIDEO_RECORDER = rec };

  class VideoRecorder {
    // 簡易デバイス判定
    isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Windows Phone|webOS/i.test(navigator.userAgent)
    // 表示関連
    videoPreview = null
    canvasElement = null
    longSide = 640
    shortSide = 360
    isPreviewLoaded = false
    // ウィンドウの向きとアスペクト比(startCamera内で値が入る)
    // 768px以上 または 横長の画面の場合、横長のカメラ情報を取得する 
    // 768pxより小さい場合 かつ 縦長の画面の場合は縦長のカメラとして取得する
    // 取得しようとしたストリームと、取得できたストリームの縦横が逆転している場合、1度だけ再実行する
    // 録画データのアスペクト比は、最終的に取得したストリームのアスペクト比に応じて、縦長 or 横長を選択する
    isSmallerThan768px = null
    windowAspectRatio = null
    isPortraitCamera = null
    videoPreviewAspectRatio
    // 映像・オーディオ設定関連
    cameraSupported = false
    isRecording = false
    stream = null
    /** @type {MediaRecorder} */
    mediaRecorder = null
    mimeType = null
    recordedChunks = []
    videoDevices = []
    audioDevices = []
    selectedVideoDevice = ""
    selectedAudioDevice = ""
    // canvasは非表示だが、videoタグにプレビューを表示しつつ、録画はcanvasで行う
    // videoタグのプレビューの内容(カメラ設定とHTML設定)と、録画した映像(カメラ設定のみ)にずれが出るため
    // その補正を行うため、プレビューのvideoと、録画のcanvasを分けて、録画はcanvasで処理したものを映像データとして保管
    ctx = null
    logTextArea

    constructor(videoPreview, canvasElement, logTextArea) {
      this.videoPreview = videoPreview
      this.canvasElement = canvasElement
      this.logTextArea = logTextArea
    }

    // 初期化
    async init() {
      // カメラとマイクの存在確認
      this.cameraSupported = this.isMediaDeviceSupported() && await this.hasCameraAndMic();
    }
    isMediaDeviceSupported() {
      return !!(navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function" &&
        typeof navigator.mediaDevices.enumerateDevices === "function");
    }
    async hasCameraAndMic() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return false;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasCamera = devices.some(device => device.kind === "videoinput");
      const hasMic = devices.some(device => device.kind === "audioinput");

      return hasCamera && hasMic;
    }

    // カメラ起動(許可の取得も含む)
    async startCamera(videoWidth = null, videoHeight = null, isRetried = false) {
      // ほかのレコーダーがプレビュー中であれば停止してから開始(競合回避)
      const ar = getActiveRecorder();
      if (ar && ar !== this) {
        ar.stopCameraStream();
        setActiveRecorder(null);
      }
      // (念のため)自分の過去の録画をクリーンにしてから開始
      else if (ar && ar === this) {
        this.stopRecording();
        this.stopCameraStream();
      }

      // カメラの起動・録画準備
      try {
        // ウィンドウのアスペクト比やサイズに関する情報のセット
        this.windowAspectRatio = window.innerWidth / window.innerHeight;
        this.isSmallerThan768px = window.innerWidth < 768;
        this.isPortraitCamera = this.isSmallerThan768px && this.windowAspectRatio < 1;

        // ビデオ設定

        // デバイスに対して要求する映像の縦横を指定(指定通りにセットされるとは限らない)
        videoWidth = videoWidth || (this.isPortraitCamera ? this.shortSide : this.longSide);
        videoHeight = videoHeight || (this.isPortraitCamera ? this.longSide : this.shortSide);
        const videoConstraints = {
          width: { ideal: videoWidth },
          height: { ideal: videoHeight },
          frameRate: { ideal: 30, max: 30 }
        };
        // 選択されたビデオデバイスIDがある場合は使用
        if (this.selectedVideoDevice) {
          videoConstraints.deviceId = { exact: this.selectedVideoDevice };
        } else {
          videoConstraints.facingMode = "user";
        }

        // オーディオ設定
        const audioConstraints = {
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
          sampleRate: { ideal: 48000 },
          sampleSize: { ideal: 16 },
          channelCount: { ideal: 1 }
        };
        // 選択されたオーディオデバイスIDがある場合は使用
        if (this.selectedAudioDevice) {
          audioConstraints.deviceId = { exact: this.selectedAudioDevice };
        }

        // カメラからのストリームを取得
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: audioConstraints
        });
        // 録画前のストリームをvideo要素に表示する
        // iOSのストリームは縦横がランダムで、かつブラウザが回転を挟むことがある
        // したがって、一度video要素に表示してから縦横比を取得する
        const videoPreview = this.videoPreview;
        videoPreview.srcObject = this.stream;
        // ストリームの実際のアスペクト比を取得
        await this.setVideoPreviewAspectRatio();

        // アスペクト比が反転している場合は1回だけ再取得--}}
        const isInverted = this.checkInvertedAspectRatio();
        const logCommon = `vh:${videoHeight} vw:${videoWidth} portailt: ${this.isPortraitCamera} actualVideo: [w: ${videoPreview.clientWidth} h: ${videoPreview.clientHeight}]`
        if (isInverted && !isRetried) {
          // this.stopCameraStream();
          this.log(`VH Retry: ${logCommon}`)
          return this.startCamera(videoHeight, videoWidth, true);
        } else {
          this.log(`VH Fixed: ${logCommon}`)
        }

        // 録画プレビューのロード完了
        this.isPreviewLoaded = true;

        // canvas要素のサイズを設定
        this.setCanvasSize();
        // canvasを生成
        this.ctx = this.canvasElement.getContext("2d");

        // 優先順位順にMIMEタイプを設定
        const mimeTypes = [
          "video/mp4;codecs=h264,aac",
          "video/mp4;codecs=h264",
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm"
        ];

        // 録画オプションの設定
        const options = {
          videoBitsPerSecond,
          audioBitsPerSecond,
        };

        for (const type of mimeTypes) {
          if (MediaRecorder.isTypeSupported(type)) {
            options.mimeType = type;
            break;
          }
        }
        this.mimeType = options.mimeType || "video/webm";

        // MediaRecorderの準備と、イベントの設定

        // キャンバスからストリームを30fpsで取得
        const canvasStream = this.canvasElement.captureStream(30);
        // 音声はカメラからのストリームから取得
        const audioTracks = this.stream.getAudioTracks();
        if (audioTracks.length > 0) {
          canvasStream.addTrack(audioTracks[0]);
        }
        this.mediaRecorder = new MediaRecorder(canvasStream, options);
        // このインスタンスをアクティブとして登録
        setActiveRecorder(this);
        return true;
      } catch (err) {
        console.error("カメラ起動エラー:", err);
        return false;
      }
    }

    // 利用可能なカメラとマイクのデバイス一覧を取得(許可が取れている前提)
    async getAvailableDevices() {
      try {
        // デバイス一覧の取得
        const devices = await navigator.mediaDevices.enumerateDevices();

        const filterAndMap = (kind) =>
          devices.filter(device => device.kind === kind)
            .map(device => ({ id: device.deviceId, label: device.label }))
        // ビデオデバイスとオーディオデバイスを分離
        return {
          videoDevices: filterAndMap("videoinput"),
          audioDevices: filterAndMap("audioinput"),
        }
      } catch (err) {
        this.cameraSupported = false;
        console.error("デバイス一覧の取得に失敗しました:", err);
      }
    }

    // 取得できたカメラストリームのアスペクト比を設定する(videoのロードまで待つのでawaitを使うこと)
    async setVideoPreviewAspectRatio() {
      return new Promise((resolve) => {
        const handleLoadedMetadata = () => {
          this.videoPreviewAspectRatio = this.videoPreview.videoWidth / this.videoPreview.videoHeight;
          this.videoPreview.removeEventListener("loadedmetadata", handleLoadedMetadata);
          resolve();
        };
        // loadedmetadataイベント発火でresolveするようにする(イベントの発火待ちが可能)
        this.videoPreview.addEventListener("loadedmetadata", handleLoadedMetadata);

        // 既に読み込み完了している場合のフォールバック
        if (this.videoPreview.readyState >= 1) {
          handleLoadedMetadata();
        }
      });
    }

    // 取得しようとしたアスペクト比でカメラストリームを取得できているか
    checkInvertedAspectRatio() {
      const reqPortraitAndGetLandscape = this.isPortraitCamera && this.videoPreviewAspectRatio > 1;
      const reqLandscapeAndGetPortrait = !this.isPortraitCamera && this.videoPreviewAspectRatio < 1;
      return reqPortraitAndGetLandscape || reqLandscapeAndGetPortrait;
    }

    // 向きに応じたcanvas要素のサイズの設定
    setCanvasSize() {
      const isPortraitCameraStream = this.videoPreviewAspectRatio < 1;
      const canvasAspectRatio = isPortraitCameraStream ? 9 / 16 : 16 / 9;

      let width, height;
      if (isPortraitCameraStream) {
        // 縦向きの場合
        height = this.longSide;
        width = height * canvasAspectRatio;
      } else {
        // 横向きの場合
        width = this.longSide;
        height = width / canvasAspectRatio;
      }
      this.canvasElement.width = width;
      this.canvasElement.height = height;
    }

    // 録画開始ボタンが押された時の処理(カメラ起動が終わっている前提)
    startRecording() {
      if (!this.mediaRecorder || this.isRecording) { return }
      this.recordedChunks = [];
      this.isRecording = true;

      // 録画データが利用可能になったときの処理(start(100)なので、100msごとにBlobのチャンクとして配列に保存)
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };
      // video要素に表示されている内容をcanvasでキャプチャしてストリームに流す
      this.drawFrame();
      this.mediaRecorder.start(100);
    }

    // 録画停止ボタンが押された時の処理(onstopは別で実行される)
    async stopRecording() {
      return new Promise(resolve => {
        if (!this.mediaRecorder || !this.isRecording) {
          return resolve({})
        }

        // 録画停止時の処理
        this.mediaRecorder.onstop = (event) => {
          const mimeType = this.mimeType
          const blob = new Blob(this.recordedChunks, { type: mimeType });
          // 録画の終了処理
          this.isRecording = false;
          this.recordedChunks = [];

          this.mediaRecorder.onstop = null
          this.mediaRecorder.ondataavailable = null
          resolve({ blob, mimeType, event })
        };
        this.mediaRecorder.stop();

        // アニメーションフレームIDを使ってキャンセル(メモリリーク対策)
        if (this.animationFrameId) {
          cancelAnimationFrame(this.animationFrameId);
          this.animationFrameId = null;
        }
      })
    }

    // ストリームを止めて、プレビューも停止
    stopCameraStream() {
      if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
      }
      this.videoPreview.srcObject = null;
      this.isPreviewLoaded = false;

      const ar = getActiveRecorder();
      if (ar === this) {
        setActiveRecorder(null);
      }
    }

    // canvasのフレームを描画する
    drawFrame() {
      if (!this.stream) return;

      // video要素のサイズではなく、映像のサイズ
      const videoWidth = this.videoPreview.videoWidth;
      const videoHeight = this.videoPreview.videoHeight;
      // canvasが録画データのサイズ
      const canvasWidth = this.canvasElement.width;
      const canvasHeight = this.canvasElement.height;
      // videoのサイズとcanvasサイズが不一致の場合の補正
      this.drawVideoFitted(videoWidth, videoHeight, canvasWidth, canvasHeight);

      // 録画中はcanvasを継続的に更新 / animationFrameIdは録画終了時に開放するメモリリーク対策
      if (this.isRecording) {
        this.animationFrameId = requestAnimationFrame(() => this.drawFrame());
      }
    }
    // 動画を適切なアスペクト比でcanvasに描画する補助メソッド
    drawVideoFitted(videoWidth, videoHeight, canvasWidth, canvasHeight) {
      // アスペクト比を保持しながらフィット（カバーモード）
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
      // drawImageでvideoPreviewの今の状態を切り出して描画
      this.ctx.drawImage(
        this.videoPreview,
        x,
        y,
        drawWidth,
        drawHeight
      );
    }

    updateVideoDevice(deviceId) {
      console.log("**************** updateVideoDevice")
      if (this.selectedVideoDevice !== deviceId) {
        this.selectedVideoDevice = deviceId
        if (this.isPreviewLoaded) {
          this.stopCameraStream()
          this.startCamera()
        }
      }
    }

    updateAudioDevice(deviceId) {
      console.log("**************** updateAudioDevice")
      if (this.selectedAudioDevice !== deviceId) {
        this.selectedAudioDevice = deviceId
        if (this.isPreviewLoaded) {
          this.stopCameraStream()
          this.startCamera()
        }
      }
    }
    log(log) {
      const t = new Date().toLocaleTimeString()
      this.logTextArea.value += `${t} ${log}\n`
    }
  }

  /**
   * @typedef {{
  *   selector: string | HTMLElement,
  *   messageForUnsupported?: string
  * }} InitParam
  * @returns 
  */

  const writeHtml = (/** @type {HTMLElement} */elem, messageForUnsupported) => {
    //  プレビュー表示はvideoで行い、録画はcanvas内で行う
    elem.innerHTML = `
     <video autoplay playsinline muted style="width: 100%; object-fit: contain; transform: scaleX(-1)">
       <p></p>
     </video>
     <canvas style="display:none;"></canvas>
   `;
    const video = elem.querySelector("video")
    const elemForUnsupported = video.querySelector("p")
    elemForUnsupported.innerHTML = messageForUnsupported || "Video Not Supported";
    const canvas = elem.querySelector("canvas")
    return { video, canvas }
  }

  /**
    * 
    * @param {{
    *   elems: { video: HTMLVideoElement, canvas: HTMLCanvasElement }
    * }} param0 
    */
  const createVideoObject = async ({ elems, logTextArea }) => {

    const vr = new VideoRecorder(elems.video, elems.canvas, logTextArea)
    await vr.init()
    return {
      get cameraSupported() { return vr.cameraSupported },
      startPreview: async () => await vr.startCamera(),
      stopPreview: () => vr.stopCameraStream(),
      getAvailableDevices: async () => await vr.getAvailableDevices(),
      startRecording: () => vr.startRecording(),
      stopRecording: async () => vr.stopRecording(),
      set videoDevice(value) {
        vr.updateVideoDevice(value)
      },
      set audioDevice(value) { vr.updateAudioDevice(value) },
    }
  }

  /**
   * 
   * @param {InitParam}
   */
  const init = async ({ selector, messageForUnsupported, logTextArea }) => {
    let elems
    if (selector instanceof HTMLElement) {
      elems = writeHtml(selector, messageForUnsupported)
    } else if (typeof selector === "string") {
      const elem = document.querySelector(selector)
      if (!elem) {
        throw new Error("element not found: " + selector)
      }
      elems = writeHtml(elem, messageForUnsupported)
    } else {
      throw new Error("invalid selector: " + selector)
    }
    return await createVideoObject({ elems, logTextArea })
  }

  return {
    init
  }
})()