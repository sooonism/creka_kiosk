<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  let canvas: HTMLCanvasElement;
  let status = $state("Initializing...");
  let fps = $state(0);
  let error = $state<string | null>(null);
  let handsDetected = $state(0);

  let video: HTMLVideoElement | null = null;
  let stream: MediaStream | null = null;
  let handLandmarkerInstance: any;
  let running = true;
  let frameCount = 0;
  let lastFpsUpdate = 0;

  let smoothedLm: { x: number; y: number }[] | null = null;
  let smoothing = $state(0.25);

  let painting = $state(false);
  let bufferActive = $state(false);
  let bufferProgress = $state(0);
  let gestureLabel = $state("—");
  let bufferStart = 0;
  let bufferTime = $state(2000);
  let brushWidth = $state(6);
  let brushOpacity = $state(1.0);

  let strokes: { pts: {x:number,y:number}[]; color: string; opacity: number }[] = [];
  let currentStroke: { pts: {x:number,y:number}[]; color: string; opacity: number } | null = null;
  let tipX = 0, tipY = 0;
  let lastTipX = 0, lastTipY = 0;
  let fingerStill = $state(false);
  const STILL_THRESHOLD = 12;

  let resetHover = $state(false);
  let resetProgress = $state(0);
  let resetStart = 0;
  const RESET_MS = 3000;

  let swatchHoverIdx = $state(-1);
  let swatchHoverStart = 0;
  const SWATCH_HOVER_MS = 600;
  let selectedColorIdx = $state(6);
  let selectedColor = $state<string | null>(null);

  const COLS = ["#ff6b6b", "#fbbf24", "#34d399", "#00dcff", "#a78bfa", "#ffffff", ""];
  const SETTINGS_BAR_H = 56;

  const WRIST = 0, INDEX_TIP = 8, INDEX_PIP = 6, THUMB_TIP = 4;

  const HAND_CONNECTIONS: [number, number][] = [
    [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
    [0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17],
  ];

  const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
  const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";

  function dist(a: {x:number;y:number}, b: {x:number;y:number}) { return Math.hypot(a.x-b.x, a.y-b.y); }

  function fingerExtended(lm: {x:number;y:number}[], tip:number, pip:number, mcp:number): boolean {
    const t=lm[tip],p=lm[pip],m=lm[mcp]; if(!t||!p||!m)return false;
    const hs=dist(lm[WRIST],lm[5]); return hs>0.01 && dist(lm[WRIST],t) > dist(lm[WRIST],p) + hs*0.12;
  }

  function classifyGesture(lm: {x:number;y:number}[]): string {
    if(!lm||lm.length<21)return"?";
    const iE=fingerExtended(lm,INDEX_TIP,INDEX_PIP,5), mE=fingerExtended(lm,12,10,9);
    const rE=fingerExtended(lm,16,14,13), pE=fingerExtended(lm,20,18,17);
    const tE=fingerExtended(lm,THUMB_TIP,3,2);
    const n=[iE,mE,rE,pE].filter(Boolean).length;
    if(n===0)return"fist";
    if(iE&&!mE&&!rE&&!pE&&!tE)return"point";
    if(iE&&!mE&&!rE&&!pE)return"point+thumb";
    if(iE&&mE&&!rE&&!pE)return"peace";
    if(n>=4)return"palm";
    return n+"up";
  }

  function hexToRgb(h:string):{r:number;g:number;b:number}|null {
    const m=h.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    return m?{r:parseInt(m[1],16),g:parseInt(m[2],16),b:parseInt(m[3],16)}:null;
  }

  onMount(async()=>{try{await initMediaPipe();await initCamera();status="Point to paint";startLoop();}catch(e){error=e instanceof Error?e.message:"Unknown error";status="Failed";}});
  onDestroy(()=>{running=false;if(stream)stream.getTracks().forEach(t=>t.stop());if(video){video.pause();video.srcObject=null;}if(handLandmarkerInstance)handLandmarkerInstance.close();});

  async function initMediaPipe(){
    const {FilesetResolver,HandLandmarker}=await import("@mediapipe/tasks-vision");
    const vision=await FilesetResolver.forVisionTasks(WASM_CDN);
    status="Loading hand model...";
    handLandmarkerInstance=await HandLandmarker.createFromOptions(vision,{baseOptions:{modelAssetPath:MODEL,delegate:"GPU"},runningMode:"VIDEO",numHands:1});
  }

  async function initCamera(){
    status="Opening camera...";
    stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:"user"},audio:false});
    video=document.createElement("video");video.srcObject=stream;video.playsInline=true;video.muted=true;video.autoplay=true;
    await video.play();if(!canvas)return;canvas.width=video.videoWidth||640;canvas.height=video.videoHeight||480;
  }

  function startLoop(){
    function detect(){
      if(!running||!video)return;
      if(video.readyState>=2){
        const now=performance.now();
        const result=handLandmarkerInstance?.detectForVideo(video,now);
        handsDetected=result?.landmarks?.length??0;
        drawFrame(result,now);
        frameCount++;
        if(now-lastFpsUpdate>1000){fps=Math.round((frameCount*1000)/(now-lastFpsUpdate));frameCount=0;lastFpsUpdate=now;}
      }
      requestAnimationFrame(detect);
    }
    requestAnimationFrame(detect);
  }

  function drawFrame(result:any,now:number){
    if(!video)return;
    const ctx=canvas.getContext("2d")!;
    const w=canvas.width,h=canvas.height;
    const barH=SETTINGS_BAR_H;

    const offscreen=new OffscreenCanvas(w,h);
    const offCtx=offscreen.getContext("2d")!;
    offCtx.save();offCtx.scale(-1,1);offCtx.drawImage(video,-w,0,w,h);offCtx.restore();
    const pixels=offCtx.getImageData(0,0,w,h);

    ctx.save();ctx.scale(-1,1);ctx.drawImage(video,-w,0,w,h);ctx.restore();

    // Draw strokes
    for(const s of[...strokes,currentStroke].filter(Boolean)){
      if(!s||s.pts.length<2)continue;
      ctx.save();
      ctx.globalAlpha=s.opacity;
      ctx.strokeStyle=s.color;ctx.lineWidth=brushWidth;ctx.lineCap="round";ctx.lineJoin="round";
      ctx.beginPath();ctx.moveTo(s.pts[0].x,s.pts[0].y);
      for(let i=1;i<s.pts.length;i++)ctx.lineTo(s.pts[i].x,s.pts[i].y);
      ctx.stroke();
      ctx.restore();
    }

    const handPresent=result?.landmarks?.[0]!=null;

    if(handPresent){
      const rawLm=result.landmarks[0];
      if(!smoothedLm||smoothedLm.length!==rawLm.length){smoothedLm=rawLm.map((p:any)=>({x:p.x,y:p.y}));}
      else{for(let i=0;i<rawLm.length;i++){smoothedLm[i].x+=(rawLm[i].x-smoothedLm[i].x)*smoothing;smoothedLm[i].y+=(rawLm[i].y-smoothedLm[i].y)*smoothing;}}
      const lm=smoothedLm;
      const gesture=classifyGesture(lm);
      gestureLabel=gesture;
      const idx=lm[INDEX_TIP];
      tipX=idx?w-idx.x*w:0; tipY=idx?idx.y*h:0;

      // Stillness check — only start buffer when finger is still
      const tipMoved = Math.hypot(tipX-lastTipX, tipY-lastTipY);
      fingerStill = tipMoved < STILL_THRESHOLD;

      // Swatch detection (top)
      const uiY=12, ss=28, sg=6;
      const totalW=COLS.length*ss+(COLS.length-1)*sg;
      const swStartX=w-44-8-totalW;
      let newSwatch=-1;
      for(let i=0;i<COLS.length;i++){
        const sx=swStartX+i*(ss+sg);
        if(tipX>=sx&&tipX<=sx+ss&&tipY>=uiY&&tipY<=uiY+ss){newSwatch=i;break;}
      }
      if(newSwatch>=0){if(swatchHoverIdx!==newSwatch){swatchHoverIdx=newSwatch;swatchHoverStart=now;}else if(now-swatchHoverStart>=SWATCH_HOVER_MS){selectedColorIdx=newSwatch;selectedColor=COLS[newSwatch]||null;}}
      else swatchHoverIdx=-1;

      // Reset detection (top-right)
      const rX=w-44,rY=12,rS=28;
      if(tipX>=rX&&tipX<=rX+rS&&tipY>=rY&&tipY<=rY+rS){if(!resetHover){resetHover=true;resetStart=now;}resetProgress=Math.min(1,(now-resetStart)/RESET_MS);if(now-resetStart>=RESET_MS){strokes=[];currentStroke=null;painting=false;resetHover=false;resetProgress=0;}}
      else{resetHover=false;resetProgress=0;}

      // Settings bar controls detection (bottom)
      const barY=h-barH;
      const isOverUI = swatchHoverIdx>=0 || resetHover || (tipY>=barY);

      // Brush width slider (bottom-left)
      const sw=120, sx=16, sy=barY+12;
      if(tipY>=sy&&tipY<=sy+16&&tipX>=sx&&tipX<=sx+sw) brushWidth=Math.max(1,Math.round(2+((tipX-sx)/sw)*18));

      // Opacity slider
      const ox=sx+sw+20;
      if(tipY>=sy&&tipY<=sy+16&&tipX>=ox&&tipX<=ox+sw) brushOpacity=Math.max(0.1,Math.min(1,((tipX-ox)/sw)));

      // Buffer slider
      const bx=ox+sw+20;
      if(tipY>=sy&&tipY<=sy+16&&tipX>=bx&&tipX<=bx+sw) bufferTime=Math.max(500,Math.round(500+((tipX-bx)/sw)*4500));

      // Smoothing slider
      const smx=bx+sw+20;
      if(tipY>=sy&&tipY<=sy+16&&tipX>=smx&&tipX<=smx+sw) smoothing=Math.max(0.05,Math.min(0.5,((tipX-smx)/sw)*0.45+0.05));

      // Clear button
      const clx=smx+sw+12;
      if(tipY>=sy-2&&tipY<=sy+18&&tipX>=clx&&tipX<=clx+50){
        if(!resetHover){resetHover=true;resetStart=now;}resetProgress=Math.min(1,(now-resetStart)/RESET_MS);
        if(now-resetStart>=RESET_MS){strokes=[];currentStroke=null;painting=false;resetHover=false;resetProgress=0;}
      }else if(tipY<barY){resetHover=false;resetProgress=0;}

      // Gesture logic
      if(gesture==="fist"){
        painting=false;bufferActive=false;bufferProgress=0;
        if(currentStroke&&currentStroke.pts.length>1)strokes=[...strokes,currentStroke];currentStroke=null;
      }else if(gesture==="point"||gesture==="point+thumb"){
        if(isOverUI){bufferActive=false;bufferProgress=0;}
        else{
          const color=selectedColor||`rgb(${samplePixel(tipX,tipY,pixels,w,h)})`;
          const isEyedrop=selectedColorIdx===COLS.length-1;
          if(!painting){
            if(!fingerStill){bufferActive=false;bufferProgress=0;bufferStart=0;}
            else{
              if(!bufferActive||bufferStart===0){bufferActive=true;bufferStart=now;}
              bufferProgress=Math.min(1,(now-bufferStart)/bufferTime);
              if(now-bufferStart>=bufferTime){
              painting=true;bufferActive=false;bufferProgress=0;
              const c=isEyedrop?`rgb(${samplePixel(tipX,tipY,pixels,w,h)})`:color;
              currentStroke={pts:[{x:Math.round(tipX),y:Math.round(tipY)}],color:c,opacity:brushOpacity};
              lastTipX=tipX;lastTipY=tipY;
            }
            }
          }else{
            const c=isEyedrop?`rgb(${samplePixel(tipX,tipY,pixels,w,h)})`:color;
            if(currentStroke){currentStroke.color=c;currentStroke.opacity=brushOpacity;}
            const steps=Math.max(1,Math.round(Math.hypot(tipX-lastTipX,tipY-lastTipY)/2));
            for(let s=0;s<=steps;s++){const t=steps>0?s/steps:1;const px=Math.round(lastTipX+(tipX-lastTipX)*t);const py=Math.round(lastTipY+(tipY-lastTipY)*t);if(currentStroke)currentStroke.pts.push({x:px,y:py});}
            lastTipX=tipX;lastTipY=tipY;
          }
        }
      }else{bufferActive=false;bufferProgress=0;if(currentStroke&&currentStroke.pts.length>1)strokes=[...strokes,currentStroke];currentStroke=null;}

      // ── Draw swatches (top) ──
      for(let i=0;i<COLS.length;i++){
        const sx2=swStartX+i*(ss+sg);
        const isActive=selectedColorIdx===i, isHover=swatchHoverIdx===i;
        ctx.save();
        ctx.fillStyle="rgba(0,0,0,0.5)";ctx.beginPath();ctx.roundRect(sx2-2,uiY-2,ss+4,ss+4,6);ctx.fill();
        if(COLS[i]){ctx.fillStyle=COLS[i];ctx.fillRect(sx2,uiY,ss,ss);}
        else{ctx.fillStyle="rgba(255,255,255,0.15)";ctx.font="16px sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText("💉",sx2+ss/2,uiY+ss/2);}
        ctx.strokeStyle=isActive?"#ffffff":isHover?"rgba(255,255,255,0.4)":"rgba(255,255,255,0.08)";
        ctx.lineWidth=isActive?2:1;ctx.strokeRect(sx2,uiY,ss,ss);
        ctx.restore();
      }

      // ── Draw reset (top-right) ──
      ctx.save();
      ctx.fillStyle=resetHover?"rgba(255,100,100,0.2)":"rgba(0,0,0,0.45)";
      ctx.beginPath();ctx.roundRect(rX,rY,rS,rS,8);ctx.fill();
      if(resetHover){ctx.strokeStyle="rgba(255,100,100,0.8)";ctx.lineWidth=2;ctx.lineCap="round";ctx.beginPath();ctx.arc(rX+rS/2,rY+rS/2,rS/2-2,-Math.PI/2,-Math.PI/2+Math.PI*2*resetProgress);ctx.stroke();}
      ctx.fillStyle=resetHover?"#ff6b6b":"rgba(255,255,255,0.3)";ctx.font="14px sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText("✕",rX+rS/2,rY+rS/2);
      ctx.restore();

      // ── Draw settings bar (bottom) ──
      ctx.save();
      ctx.fillStyle="rgba(10,10,15,0.8)";ctx.fillRect(0,barY,w,barH);
      ctx.strokeStyle="rgba(255,255,255,0.05)";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,barY);ctx.lineTo(w,barY);ctx.stroke();

      const labelY=barY+8, sliderY=barY+26, sliderW=100;
      ctx.font="8px monospace";ctx.textBaseline="top";ctx.fillStyle="rgba(255,255,255,0.3)";

      // Width
      ctx.fillText("Width",sx,labelY);
      ctx.fillStyle="rgba(255,255,255,0.08)";ctx.fillRect(sx,sliderY,sliderW,6);
      ctx.fillStyle="#00dcff";ctx.fillRect(sx,sliderY,((brushWidth-1)/19)*sliderW,6);
      ctx.fillStyle="rgba(255,255,255,0.5)";ctx.font="7px monospace";ctx.textAlign="right";ctx.fillText(brushWidth+"px",sx+sliderW,labelY-2);

      // Opacity
      ctx.textAlign="left";
      ctx.fillStyle="rgba(255,255,255,0.3)";ctx.fillText("Opacity",ox,labelY);
      ctx.fillStyle="rgba(255,255,255,0.08)";ctx.fillRect(ox,sliderY,sliderW,6);
      ctx.fillStyle="#34d399";ctx.fillRect(ox,sliderY,brushOpacity*sliderW,6);
      ctx.fillStyle="rgba(255,255,255,0.5)";ctx.font="7px monospace";ctx.textAlign="right";ctx.fillText(brushOpacity.toFixed(2),ox+sliderW,labelY-2);

      // Buffer
      ctx.textAlign="left";
      ctx.fillStyle="rgba(255,255,255,0.3)";ctx.fillText("Buffer",bx,labelY);
      ctx.fillStyle="rgba(255,255,255,0.08)";ctx.fillRect(bx,sliderY,sliderW,6);
      ctx.fillStyle="#fbbf24";ctx.fillRect(bx,sliderY,((bufferTime-500)/4500)*sliderW,6);
      ctx.fillStyle="rgba(255,255,255,0.5)";ctx.font="7px monospace";ctx.textAlign="right";ctx.fillText((bufferTime/1000).toFixed(1)+"s",bx+sliderW,labelY-2);

      // Smooth
      ctx.textAlign="left";
      ctx.fillStyle="rgba(255,255,255,0.3)";ctx.fillText("Smooth",smx,labelY);
      ctx.fillStyle="rgba(255,255,255,0.08)";ctx.fillRect(smx,sliderY,sliderW,6);
      ctx.fillStyle="#a78bfa";ctx.fillRect(smx,sliderY,((smoothing-0.05)/0.45)*sliderW,6);
      ctx.fillStyle="rgba(255,255,255,0.5)";ctx.font="7px monospace";ctx.textAlign="right";ctx.fillText(smoothing.toFixed(2),smx+sliderW,labelY-2);

      // Clear button
      ctx.textAlign="left";
      ctx.fillStyle=resetHover?"#ff6b6b":"rgba(255,255,255,0.3)";ctx.fillText("Clear",clx,labelY);
      ctx.fillStyle=resetHover?"rgba(255,100,100,0.2)":"rgba(255,255,255,0.04)";
      ctx.beginPath();ctx.roundRect(clx,sliderY-4,46,14,6);ctx.fill();
      if(resetHover&&tipY>=barY){
        ctx.strokeStyle="rgba(255,100,100,0.8)";ctx.lineWidth=1.5;ctx.lineCap="round";
        ctx.beginPath();ctx.arc(clx+23,sliderY+3,7,-Math.PI/2,-Math.PI/2+Math.PI*2*resetProgress);ctx.stroke();
      }
      // Undo button
      const ux=clx+58;
      ctx.fillStyle="rgba(255,255,255,0.3)";ctx.fillText("Undo",ux,labelY);
      ctx.fillStyle="rgba(255,255,255,0.04)";ctx.beginPath();ctx.roundRect(ux,sliderY-4,46,14,6);ctx.fill();
      // Undo via finger hover — quick action
      if(tipY>=sliderY-4&&tipY<=sliderY+10&&tipX>=ux&&tipX<=ux+46&&strokes.length>0){
        // Undo last stroke - do it once by checking just the first frame of hover
        if(!window._undoFired){window._undoFired=true;strokes=strokes.slice(0,-1);}
      }else{window._undoFired=false;}

      // Stroke count
      ctx.fillStyle="rgba(255,255,255,0.12)";ctx.font="8px monospace";ctx.textAlign="right";
      const totalPts=strokes.reduce((a,s)=>a+s.pts.length,0)+(currentStroke?.pts.length||0);
      ctx.fillText(`${strokes.length+(currentStroke?1:0)} strokes · ${totalPts} pts`,w-12,labelY);

      ctx.restore();

      // ── Hand skeleton ──
      ctx.save();
      ctx.strokeStyle="rgba(0,220,255,0.12)";ctx.lineWidth=1;
      for(const[a,b]of HAND_CONNECTIONS){const p1=lm[a],p2=lm[b];if(!p1||!p2)continue;ctx.beginPath();ctx.moveTo(w-p1.x*w,p1.y*h);ctx.lineTo(w-p2.x*w,p2.y*h);ctx.stroke();}
      for(const pt of lm){ctx.beginPath();ctx.arc(w-pt.x*w,pt.y*h,1.2,0,Math.PI*2);ctx.fillStyle="rgba(0,220,255,0.15)";ctx.fill();}
      ctx.restore();

      // Tip highlight
      ctx.save();ctx.shadowColor="rgba(0,220,255,0.4)";ctx.shadowBlur=14;
      ctx.fillStyle=painting?"#34d399":bufferActive?"#fbbf24":"rgba(0,220,255,0.4)";
      ctx.beginPath();ctx.arc(tipX,tipY,6,0,Math.PI*2);ctx.fill();ctx.restore();

      // Buffer arc
      if(bufferActive){ctx.save();ctx.strokeStyle="rgba(255,255,255,0.6)";ctx.lineWidth=3;ctx.lineCap="round";ctx.shadowColor="rgba(0,220,255,0.3)";ctx.shadowBlur=10;ctx.beginPath();ctx.arc(tipX,tipY,22,-Math.PI/2,-Math.PI/2+Math.PI*2*bufferProgress);ctx.stroke();ctx.restore();}
    }else{
      painting=false;bufferActive=false;bufferProgress=0;gestureLabel="—";
      resetHover=false;resetProgress=0;swatchHoverIdx=-1;
      if(currentStroke&&currentStroke.pts.length>1)strokes=[...strokes,currentStroke];currentStroke=null;
      window._undoFired=false;
    }

    // HUD top-left
    ctx.save();
    ctx.fillStyle="rgba(0,0,0,0.45)";ctx.beginPath();ctx.roundRect(12,50,70,22,6);ctx.fill();
    ctx.fillStyle="#00dcff";ctx.font="11px monospace";ctx.textBaseline="middle";ctx.textAlign="left";ctx.fillText(`${fps}fps`,18,61);
    if(handsDetected>0){ctx.fillStyle="rgba(0,0,0,0.45)";ctx.beginPath();ctx.roundRect(12,78,80,22,6);ctx.fill();ctx.fillStyle="rgba(255,255,255,0.3)";ctx.font="10px monospace";ctx.fillText(gestureLabel,18,89);}
    ctx.restore();
  }

  function samplePixel(x:number,y:number,imgData:ImageData,w:number,h:number):string{
    const sx=Math.min(Math.floor(x),w-1),sy=Math.min(Math.floor(y),h-1),pi=(sy*w+sx)*4;
    return `${imgData.data[pi]},${imgData.data[pi+1]},${imgData.data[pi+2]}`;
  }
</script>

<div class="fp-page">
  <canvas bind:this={canvas} class="fp-canvas"></canvas>
  {#if error}
    <div class="overlay error"><div class="overlay-icon">⚠️</div><div class="overlay-text">{error}</div></div>
  {/if}
</div>

<style>
  .fp-page { position:fixed; inset:0; background:#000; display:flex; align-items:center; justify-content:center; }
  .fp-canvas { display:block; width:100%; height:100%; object-fit:contain; }
  .overlay { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; background:rgba(0,0,0,0.85); }
  .overlay.error .overlay-icon { font-size:3rem; margin-bottom:1rem; }
  .overlay-text { color:#f87171; font-size:1.2rem; }
</style>
