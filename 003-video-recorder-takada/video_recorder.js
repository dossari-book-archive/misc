document.addEventListener("DOMContentLoaded", () => {
  const elem = document.getElementById("libVersion")
  if (elem) {
    elem.innerText = "2025/11/22 14:30"
  }
})

window.MyVideoRecorder = (() => {

  // VideoRecorderのクラスやインスタンスのみから共通して参照可能な変数
  // 即時関数で
  const videoBitsPerSecond = 800000
  const audioBitsPerSecond = 128000
  let stream = null
  let hasPermission = false

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
      // 権限の確認
      await this.checkPermissions();
    }
    isMediaDeviceSupported() {
      return !!(navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function" &&
        typeof navigator.mediaDevices.enumerateDevices === "function");
    }
    // 許可がなくてもカメラとマイクが存在するかどうかは確認できる
    async hasCameraAndMic() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return false;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasCamera = devices.some(device => device.kind === "videoinput");
      const hasMic = devices.some(device => device.kind === "audioinput");

      return hasCamera && hasMic;
    }
    // name: 'camera' | 'microphone' それぞれ許可状態を取得
    async getPermissionState(name) {
      try {
        // 一部ブラウザでは 'camera' / 'microphone' が未定義だが try/catch で握りつぶす
        if (!navigator.permissions || !navigator.permissions.query) return "prompt";
        const res = await navigator.permissions.query({ name });
        return res.state; // 'granted' | 'denied' | 'prompt'
      } catch {
        return "prompt";
      }
    }
    // 権限をチェック
    async checkPermissions() {
      const camState = await this.getPermissionState("camera");
      const micState = await this.getPermissionState("microphone");
      hasPermission = (camState === "granted" && micState === "granted");
    }
    // カメラとマイクの許可を取得
    async ensurePermissions() {
      // すでに許可がある場合は何もしない
      if (hasPermission) {
        return true;
      }

      let probeStream = null;
      // ここで両方まとめて要求(1回のダイアログ)
      try {
        probeStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        // 許可が取れなければ例外が出るので、ここまで来たら許可が取れたと判断

        // 許可を取るタイミングで選択されたデバイスIDを保存
        this.selectedVideoDevice = probeStream.getVideoTracks()[0]?.getSettings()?.deviceId || "";
        this.selectedAudioDevice = probeStream.getAudioTracks()[0]?.getSettings()?.deviceId || "";

        // 許可取得成功
        hasPermission = true;
      } catch (err) {
        console.error("カメラ・マイクの許可取得に失敗:", err);
        return false;
      } finally {
        // ストリームを停止
        if (probeStream) {
          probeStream.getTracks().forEach(t => t.stop());
        }
      }
      return hasPermission;
    }

    // カメラ起動(許可の取得も含む)
    async startCamera(videoWidth = null, videoHeight = null, isRetried = false) {
      // 別のmediaRecorderがある場合は停止
      this.stopRecording();
      this.stopCameraStream();

       // ストリームをセットする前に隠す
       // 一瞬表示させてから縦横比を取得したりしているため
      this.videoPreview.style.opacity = "0"; 
      this.videoPreview.style.transition = "opacity 0.3s";

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
          frameRate: { ideal: 30, max: 30 },
          facingMode: "user"
        };
        // 選択されたビデオデバイスIDがある場合は使用
        if (this.selectedVideoDevice) {
          videoConstraints.deviceId = { exact: this.selectedVideoDevice };
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

        // カメラからのストリームを取得(共有)
        stream = stream || await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: audioConstraints
        });
        // 録画前のストリームをvideo要素に表示する
        // iOSのストリームは縦横がランダムで、かつブラウザが回転を挟むことがある
        // したがって、一度video要素に表示してから縦横比を取得する
        const videoPreview = this.videoPreview;
        videoPreview.srcObject = stream;

        // ストリームの実際のアスペクト比を取得
        await this.setVideoPreviewAspectRatio();
        // アスペクト比が反転している場合は1回だけ再取得
        const isInverted = this.checkInvertedAspectRatio();
        const logCommon = `vh:${videoHeight} vw:${videoWidth} portailt: ${this.isPortraitCamera} actualVideo: [w: ${videoPreview.clientWidth} h: ${videoPreview.clientHeight}]`
        if (isInverted && !isRetried) {
          // this.stopCameraStream();
          this.log(`VH Retry: ${logCommon}`)
          return this.startCamera(videoHeight, videoWidth, true);
        } else {
          this.log(`VH Fixed: ${logCommon}`)
        }

        /* プレビューだけならここまででよいが、カメラ起動時にMediaRecorderも準備しておく */
        // canvas要素のサイズを設定
        this.setCanvasSize();
        // canvasを生成
        this.ctx = this.canvasElement.getContext("2d");

        // 優先順位順にMIMEタイプを設定
        // codecsは=でいけるものも多いが一部:でないといけないので:で統一
        const mimeTypes = [
          "video/mp4;codecs:h264,aac",
          "video/mp4;codecs:h264",
          "video/mp4",
          "video/webm;codecs:vp9,opus",
          "video/webm;codecs:vp8,opus",
          "video/webm"
        ];

        // 録画オプションの設定
        const options = {
          videoBitsPerSecond,
          audioBitsPerSecond        };
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
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
          canvasStream.addTrack(audioTracks[0]);
        }
        this.mediaRecorder = new MediaRecorder(canvasStream, options);

        // カメラ起動成功で、プレビューを表示
        this.videoPreview.style.opacity = "1";

         // 録画プレビューのロード完了
        this.isPreviewLoaded = true;
        return true;
      } catch (err) {
        console.error("カメラ起動エラー:", err);
        this.stopCameraStream();
        return false;
      }
    }

    // 利用可能なカメラとマイクのデバイス一覧を取得
    async getAvailableDevices() {
      try {
        // 許可を取っていなければ取る
        if (!await this.ensurePermissions()) {
          this.cameraSupported = false;
          return {
            success: false,
            videoDevices: [],
            audioDevices: []
          };
        }

        // デバイス一覧の取得
        const devices = await navigator.mediaDevices.enumerateDevices();

        // 取得したデバイス一覧から、必要な情報だけを抽出するヘルパー関数
        const filterAndMap = (kind) =>
          devices.filter(device => device.kind === kind)
            .map(device => ({ id: device.deviceId, label: device.label }))
        
        // ビデオデバイスとオーディオデバイスを分離
        const videoDevices = filterAndMap("videoinput");
        const audioDevices = filterAndMap("audioinput");
        // 先頭に「デフォルト」オプションを挿入(空IDで表現)
        const DEFAULT_VIDEO = { id: "", label: "デフォルトのカメラ" };
        const DEFAULT_AUDIO = { id: "", label: "デフォルトのマイク" };

        // 重複防止して、先頭にデフォルトを追加するヘルパー関数
        const withDefault = (list, def) =>
          list.some(d => d.id === def.id) ? list : [def, ...list];

        return {
          success: true,
          videoDevices: withDefault(videoDevices, DEFAULT_VIDEO),
          audioDevices: withDefault(audioDevices, DEFAULT_AUDIO),
        }
      } catch (err) {
        console.error("デバイス一覧の取得に失敗しました:", err);
        this.cameraSupported = false;
        return {
          success: false,
          videoDevices: [],
          audioDevices: []
        };
      }
    }

    // 取得できたカメラストリームのアスペクト比を設定する(videoのロードまで待つのでawaitを使うこと)
    setVideoPreviewAspectRatio() {
      return new Promise((resolve) => {
        const handleLoadedMetadata = () => {
          // 現在のサイズで比率を計算
          let aspect = this.videoPreview.videoWidth / this.videoPreview.videoHeight;

          // 「縦画面モードなのに、映像が横長」の場合は、回転適用待ちの可能性が高いので少し待つ
          if (this.isPortraitCamera && aspect > 1) {
            setTimeout(() => {
              // 500ms後に再取得して確定（この頃には回転が適用されているはず）
              this.videoPreviewAspectRatio = this.videoPreview.videoWidth / this.videoPreview.videoHeight;
              this.videoPreview.removeEventListener("loadedmetadata", handleLoadedMetadata);
              resolve();
            }, 500)

            // 処理を終了
            return
          }

          // 問題なければ即座に確定
          this.videoPreviewAspectRatio = aspect;
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
      if (!this.mediaRecorder || this.isRecording) {
        console.error("録画に失敗。MediaRecorderが存在しないか、既に録画中です。");
        return false;
      }
      this.recordedChunks = [];

      // 録画データが利用可能になったときの処理(start(100)なので、100msごとにBlobのチャンクとして配列に保存)
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };
      // video要素に表示されている内容をcanvasでキャプチャしてストリームに流す
      this.drawFrame();
      this.mediaRecorder.start(100);
      this.isRecording = true;

      // 録画開始成功
      return true;
    }

    // 録画停止ボタンが押された時の処理(onstopは別で実行される)
    stopRecording() {
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

          // event.targetにはthis.mediaRecorderが入っている
          //　this.mediaRecorderをクリアすると、録画停止→再録画を高速で行った際にバグが起きるかもしれない
          event.target.onstop = null
          event.target.ondataavailable = null
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
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
      }
      this.videoPreview.srcObject = null;
      this.isPreviewLoaded = false;
    }

    // canvasのフレームを描画する
    drawFrame() {
      if (!stream) return;

      // video要素のサイズではなく、映像のサイズ
      const videoWidth = this.videoPreview.videoWidth;
      const videoHeight = this.videoPreview.videoHeight;
      // canvasが録画データのサイズ
      const canvasWidth = this.canvasElement.width;
      const canvasHeight = this.canvasElement.height;
      // videoのサイズとcanvasサイズが不一致の場合の補正
      this.drawVideoFitted(videoWidth, videoHeight, canvasWidth, canvasHeight);

      // 録画中はcanvasを継続的に更新 / animationFrameIdは録画終了時に開放するメモリリーク対策
      this.animationFrameId = requestAnimationFrame(() => this.drawFrame());
    }
    // 動画を適切なアスペクト比でcanvasに描画する補助メソッド
    drawVideoFitted(videoWidth, videoHeight, canvasWidth, canvasHeight) {
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
    * @param {{
    *   elems: { video: HTMLVideoElement, canvas: HTMLCanvasElement }
    * }} param0 
    */
  const createVideoObject = async ({ elems, logTextArea }) => {

    const vr = new VideoRecorder(elems.video, elems.canvas, logTextArea)
    await vr.init()
    return {
      get cameraSupported() { return vr.cameraSupported },
      ensurePermissions: () => vr.ensurePermissions(),
      startPreview: () => vr.startCamera(),
      stopPreview: () => vr.stopCameraStream(),
      getAvailableDevices: () => vr.getAvailableDevices(),
      startRecording: () => vr.startRecording(),
      stopRecording: () => vr.stopRecording(),
      get videoDevice() { return vr.selectedVideoDevice },
      set videoDevice(value) {
        vr.updateVideoDevice(value)
      },
      get audioDevice() { return vr.selectedAudioDevice },
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
    // createVideoObjectはasyncだが、ここでawaitをしても意味は無い
    // initはasyncでPromiseを返すため、採用が発生し、awaitしてもしなくても同じ値が返る
    return createVideoObject({ elems, logTextArea })
  }

  return {
    init
  }
})()