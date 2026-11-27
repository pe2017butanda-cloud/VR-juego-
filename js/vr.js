import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { VRButton } from 'three/addons/webxr/VRButton.js';

/* Módulo VR (Meta Quest 3): WebXR en primera persona, enemigos, vida y puntaje,
   efectos de daño, escenario ampliado y apariciones aleatorias. */
export function initVR(C) {
  const { scene, camera, renderer, heroBody, hero, dynamics, CONFIG, controls } = C;
  const R = (a, b) => a + Math.random() * (b - a);
  const L = CONFIG.arenaHalf - 3;
  const town = C.town || { blockers: [], inTown: () => false, roads: [], rails: [], buildings: [], props: [] };

  /* ---------- Balance (aquí ajustas la dificultad) ---------- */
  const MAXHP = 170;                 // vida máxima del jugador
  const HIT_DMG = [4, 7];            // daño base de un impacto (se multiplica según el tipo de enemigo)
  const HIT_CHANCE = 0.45;           // probabilidad de que un disparo enemigo acierte
  const INV_TIME = 0.4;              // segundos de invulnerabilidad tras recibir un impacto
  const REGEN_DELAY = 10, REGEN_RATE = 1; // tras 10 s sin daño, se recupera 1 de vida por segundo
  const PICK_HEAL = 50;              // vida que da un botiquín
  const PICK_WAIT = [6, 10];         // segundos que tarda un botiquín en reaparecer (en otro lugar)
  const MAX_ENEMIES = [8, 22];       // enemigos simultáneos: al inicio y tope máximo (sube con el puntaje)
  // Tipos de enemigo: dmg = multiplicador de daño, pts = multiplicador de puntos
  const TYPES = {
    bandit: { w: 55, hp: 3, dmg: 1,   spd: 2.2, range: 22, keep: 7,  cd: [2, 3.5],   pts: 1,   sc: 1,    shirt: 0x5b3a22, pants: 0x2f3b4d, hat: 0x1c1410, band: 0xc8140a, tr: 0xff7a4a },
    rifle:  { w: 25, hp: 3, dmg: 1.8, spd: 1.6, range: 34, keep: 15, cd: [3.2, 5],   pts: 1.5, sc: 1.02, shirt: 0x3d4a36, pants: 0x4a4036, hat: 0x6b5f50, band: 0x2c3a2a, tr: 0xffe27a },
    brute:  { w: 20, hp: 8, dmg: 2.6, spd: 1.7, range: 16, keep: 5,  cd: [2.2, 3.4], pts: 3,   sc: 1.3,  shirt: 0x2a1c1c, pants: 0x1c1c22, hat: 0x0e0b09, band: 0x8a6a1c, tr: 0xff3a1a },
  };
  // ---- Dificultad progresiva: cada 500 puntos sube un nivel ----
  const level = () => 1 + Math.min(14, Math.floor(S.score / 500));
  const pickType = () => {
    const Lv = level() - 1, w = { bandit: Math.max(15, 55 - 4 * Lv), rifle: 25 + 2 * Lv, brute: 20 + 2.5 * Lv };
    let r = Math.random() * (w.bandit + w.rifle + w.brute);
    for (const k in w) { if ((r -= w[k]) < 0) return k; }
    return 'bandit';
  };

  const S = { hp: MAXHP, score: 0, over: 0, hurt: 0, inv: 0, deadT: 0, regen: 0, msg: '', msgT: 0, msgC: '#ff5a3a' };
  let lastLvl = 1, live = false, cd = 0, spawnT = 0, wasVR = false, snap = false, nowT = 0, deathVR = false;

  // ¿Hay una caja sólida (saloon, molino, rocas, árboles...) a menos de `m` metros de este punto?
  const solid = (x, z, m) => {
    if (!C.world) return false;
    for (const b of C.world.bodies) {
      if (b.mass !== 0 || !(b.shapes[0] instanceof CANNON.Box)) continue;
      const he = b.shapes[0].halfExtents;
      if (b.position.y - he.y > 1.5 || b.position.y + he.y < 0.2) continue; // no está a la altura del jugador
      const yaw = 2 * Math.atan2(b.quaternion.y, b.quaternion.w);
      const dx = x - b.position.x, dz = z - b.position.z;
      const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw), lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      if (Math.abs(lx) < he.x + m && Math.abs(lz) < he.z + m) return true;
    }
    return false;
  };

  // Punto aleatorio del escenario a una distancia mínima del héroe y, si m > 0, lejos de los obstáculos
  const far = (min, m = 0, out = false) => {
    for (let i = 0; i < 80; i++) {
      const x = R(-L, L), z = R(-L, L);
      if (out && (town.inTown(x, z, 2) || Math.abs(x + 31.85) < 3)) continue;
      if (Math.hypot(x - heroBody.position.x, z - heroBody.position.z) > min && !(m && solid(x, z, m))) return [x, z];
    }
    return [L, -L];
  };

  /* ---------- Navegación de enemigos: cuadrícula de 1 m + campo de flujo (BFS) hacia el jugador ----------
     Las estructuras estáticas se marcan una vez como bloqueadas; los bandidos siguen el camino más corto
     rodeando edificios, cercas, rocas y árboles, y se atajan en línea recta cuando el trayecto está libre. */
  const GN = 92, GO = 46, blocked = new Uint8Array(GN * GN), gdist = new Int16Array(GN * GN), gq = new Int32Array(GN * GN);
  let gready = false, gT = 0, gSrc = -1;
  const gi = (v) => Math.floor(v + GO);
  const gok = (ix, iz) => ix >= 0 && iz >= 0 && ix < GN && iz < GN;
  const gfree = (ix, iz) => gok(ix, iz) && !blocked[iz * GN + ix];
  function navInit() {
    for (let iz = 0; iz < GN; iz++) for (let ix = 0; ix < GN; ix++) {
      const x = ix - GO + 0.5, z = iz - GO + 0.5;
      blocked[iz * GN + ix] = (Math.abs(x) > L + 2.5 || Math.abs(z) > L + 2.5 || solid(x, z, 0.6)) ? 1 : 0;
    }
    gready = true;
  }
  function nearestFree(x, z) {            // celda libre más cercana (por si alguien queda junto a una pared)
    const cx = gi(x), cz = gi(z);
    if (gfree(cx, cz)) return cz * GN + cx;
    for (let r = 1; r < 6; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++)
      if (gfree(cx + dx, cz + dz)) return (cz + dz) * GN + cx + dx;
    return -1;
  }
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  function flowFrom(x, z) {               // distancias (en pasos) desde el jugador a cada celda
    const src = nearestFree(x, z);
    if (src < 0) return;
    gdist.fill(32000); gdist[src] = 0; gSrc = src;
    let h = 0, t = 0; gq[t++] = src;
    while (h < t) {
      const c = gq[h++], cx = c % GN, cz = (c / GN) | 0, dc = gdist[c] + 1;
      for (const [dx, dz] of NB) {
        const nx = cx + dx, nz = cz + dz;
        if (!gfree(nx, nz)) continue;
        if (dx && dz && (!gfree(cx + dx, cz) || !gfree(cx, cz + dz))) continue;   // sin cortar esquinas
        const n = nz * GN + nx;
        if (gdist[n] > dc) { gdist[n] = dc; gq[t++] = n; }
      }
    }
  }
  function lineClear(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az), n = Math.ceil(d / 0.4);
    for (let i = 1; i < n; i++) { const t = i / n; if (!gfree(gi(ax + (bx - ax) * t), gi(az + (bz - az) * t))) return false; }
    return true;
  }
  // Siguiente punto al que debe caminar un enemigo en (x,z) para alcanzar al jugador en (px,pz)
  function navTarget(x, z, px, pz) {
    if (lineClear(x, z, px, pz)) return [px, pz];
    let c = nearestFree(x, z);
    if (c < 0 || gdist[c] >= 32000) return null;
    let best = [x, z];
    for (let step = 0; step < 8 && gdist[c] > 0; step++) {
      const cx = c % GN, cz = (c / GN) | 0;
      let bn = -1, bd = gdist[c];
      for (const [dx, dz] of NB) {
        const nx = cx + dx, nz = cz + dz;
        if (!gfree(nx, nz) || (dx && dz && (!gfree(cx + dx, cz) || !gfree(cx, cz + dz)))) continue;
        const dd = gdist[nz * GN + nx];
        if (dd < bd) { bd = dd; bn = nz * GN + nx; }
      }
      if (bn < 0) break;
      c = bn;
      const tx = (c % GN) - GO + 0.5, tz = ((c / GN) | 0) - GO + 0.5;
      if (lineClear(x, z, tx, tz)) best = [tx, tz];
      else { if (step === 0) { const o = nearestFree(x, z); best = [(o % GN) - GO + 0.5, ((o / GN) | 0) - GO + 0.5]; } break; }
    }
    return best;
  }

  // Plataforma del jugador: la cámara cuelga de ella (en VR la mueve el casco)
  const rig = new THREE.Group();
  scene.add(rig);
  rig.add(camera);

  /* ---------- Sonidos sintéticos ---------- */
  let actx;
  const tone = (f, d, type = 'square', v = 0.15, f2 = f) => {
    if (C.getMuted()) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f2, t + d);
      g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
      o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + d);
    } catch (e) { /* sin audio */ }
  };
  const haptic = (s, ms, hand) => {
    try {
      for (const src of renderer.xr.getSession()?.inputSources || []) {
        if (hand && src.handedness !== hand) continue;
        src.gamepad?.hapticActuators?.[0]?.pulse(s, ms);
      }
    } catch (e) { /* sin vibración */ }
  };

  /* ---------- HUD: barra de vida (arriba a la izquierda) y puntaje en un recuadro aparte ---------- */
  const FONT = '34px RDR, "Rubik Dirt", Impact, sans-serif';
  function panel() {
    const cv = document.createElement('canvas');
    cv.width = 420; cv.height = 90;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.0514),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, fog: false }));
    mesh.renderOrder = 999; mesh.frustumCulled = false;
    camera.add(mesh);
    return { g: cv.getContext('2d'), tex, mesh, key: '' };
  }
  const healthP = panel(), scoreP = panel();
  function frame(p) {
    const g = p.g;
    g.clearRect(0, 0, 420, 90);
    g.fillStyle = 'rgba(18,10,7,.72)'; g.fillRect(0, 0, 420, 90);
    g.strokeStyle = '#d9a441'; g.lineWidth = 4; g.strokeRect(4, 4, 412, 82);
    g.font = FONT; g.textBaseline = 'middle'; g.textAlign = 'left';
    return g;
  }
  function drawHUD(msg) {
    const hp = Math.ceil(S.hp);
    if (healthP.key !== `${hp}`) {
      healthP.key = `${hp}`;
      const g = frame(healthP);
      g.fillStyle = '#d9a441'; g.fillText('VIDA', 18, 46);
      g.fillStyle = '#2a1a10'; g.fillRect(120, 29, 280, 32);
      g.fillStyle = hp > MAXHP * 0.3 ? '#c8140a' : '#ff3b2a'; g.fillRect(120, 29, 280 * Math.min(1, S.hp / MAXHP), 32);
      healthP.tex.needsUpdate = true;
    }
    if (scoreP.key !== `${S.score}|${msg}|${level()}`) {
      scoreP.key = `${S.score}|${msg}|${level()}`;
      // Sin recuadro: solo texto con contorno oscuro para que se lea sobre cualquier fondo
      const g = scoreP.g;
      g.clearRect(0, 0, 420, 90);
      g.font = FONT; g.textBaseline = 'middle'; g.textAlign = 'left';
      g.lineJoin = 'round'; g.lineWidth = 7; g.strokeStyle = 'rgba(18,10,7,.9)';
      const t = `PUNTOS  ${S.score}`;
      g.strokeText(t, 6, 46); g.fillStyle = '#ead9b0'; g.fillText(t, 6, 46);
      g.font = '22px RDR, "Rubik Dirt", Impact, sans-serif'; g.textAlign = 'right';
      const side = msg || `NIVEL ${level()}`;
      g.strokeText(side, 414, 46); g.fillStyle = msg ? S.msgC : '#ffb84a'; g.fillText(side, 414, 46);
      scoreP.tex.needsUpdate = true;
    }
  }
  // En pantalla: pegado a la esquina superior izquierda de la vista. En VR: arriba a la izquierda, a una distancia cómoda.
  function layoutHUD(inVR) {
    const w = 0.24, h = 0.0514, z = -0.9;
    let x = -0.3, y = 0.22, mx = -0.3, my = -0.2;
    if (!inVR) {
      const hh = 0.9 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      x = -hh * camera.aspect + 0.03 + w / 2;
      y = hh - 0.03 - h / 2;
      mx = -hh * camera.aspect + 0.03 + 0.1;   // minimapa: esquina inferior izquierda
      my = -hh + 0.03 + 0.1;
    }
    healthP.mesh.position.set(x, y, z);
    scoreP.mesh.position.set(x, y - h - 0.004, z);
    mmMesh.position.set(mx, my, z);
  }

  // Destello rojo al recibir daño (también cubre la vista en VR)
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ color: 0xc8140a, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false }));
  flash.position.z = -0.3; flash.renderOrder = 998; flash.frustumCulled = false;
  camera.add(flash);

  /* ---------- Partículas y trazadores ---------- */
  const pg = new THREE.BoxGeometry(0.06, 0.06, 0.06), parts = [], lines = [];
  function burst(p, color, n = 10) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color, fog: false }));
      m.position.copy(p); scene.add(m);
      parts.push({ m, v: new THREE.Vector3(R(-3, 3), R(1, 4), R(-3, 3)), life: 0.6 });
    }
  }
  function tracer(a, b, color = 0xffe2a0) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, fog: false }));
    scene.add(l); lines.push({ l, life: 0.08 });
  }

  /* ---------- Enemigos (bandidos con la misma estética del vaquero) ---------- */
  const enemies = [];
  const rc = new THREE.Raycaster();
  function makeEnemy(type = 'bandit') {
    const T = TYPES[type];
    const g = new THREE.Group(), mm = [];
    const M = (c, r = 0.85, m = 0) => { const x = new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m }); mm.push(x); return x; };
    const add = (geo, mat, x, y, z, parent = g, rot) => {
      const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z);
      if (rot) o.rotation.set(rot[0], rot[1], rot[2]);
      o.castShadow = true; parent.add(o); return o;
    };
    const skin = M([0xd9a77e, 0xc68a62, 0xa8704a, 0xe3b894][(Math.random() * 4) | 0], 0.8);
    const dark = M(0x1a1410), leather = M(0x3b2616), gold = M(0xc9a441, 0.4, 0.6), steel = M(0x2a2a2e, 0.4, 0.7);
    const big = type === 'brute', long = type === 'rifle';

    // piernas con botas
    const legs = [-0.16, 0.16].map((x) => {
      const pv = new THREE.Group(); pv.position.set(x, 0.92, 0); g.add(pv);
      add(new THREE.CapsuleGeometry(0.115, 0.6, 4, 8), M(T.pants), 0, -0.46, 0, pv);
      add(new THREE.BoxGeometry(0.2, 0.2, 0.36), leather, 0, -0.86, 0.05, pv);
      add(new THREE.BoxGeometry(0.2, 0.05, 0.1), dark, 0, -0.95, 0.2, pv);
      return pv;
    });
    // torso, chaleco, cinturón con hebilla y funda
    add(new THREE.CylinderGeometry(0.27, 0.23, 0.72, 12), M(T.shirt), 0, 1.27, 0);
    add(new THREE.CylinderGeometry(0.29, 0.245, 0.5, 12, 1, false, 0.55, Math.PI * 2 - 1.1), M(big ? 0x3a2a24 : 0x4a3220), 0, 1.3, 0);
    add(new THREE.CylinderGeometry(0.245, 0.245, 0.07, 12), dark, 0, 0.93, 0);
    add(new THREE.BoxGeometry(0.1, 0.08, 0.03), gold, 0, 0.93, 0.25);
    add(new THREE.BoxGeometry(0.09, 0.26, 0.1), leather, 0.26, 0.82, 0.04);
    if (!long) add(new THREE.BoxGeometry(0.06, 0.8, 0.04), leather, 0, 1.27, 0.255, g, [0, 0, 0.62]);   // bandolera
    if (long) add(new THREE.CylinderGeometry(0.3, 0.4, 0.95, 12, 1, true), M(0x4a4132), 0, 0.72, 0);    // abrigo largo
    if (big) {                                                                                             // poncho con cuello de piel
      add(new THREE.CylinderGeometry(0.2, 0.56, 0.62, 14, 1, true), M(0x2a1c1c), 0, 1.2, 0);
      add(new THREE.TorusGeometry(0.26, 0.075, 6, 14), M(0x6b5a48), 0, 1.52, 0, g, [Math.PI / 2, 0, 0]);
      for (const sx of [-1, 1]) add(new THREE.SphereGeometry(0.15, 8, 6), steel, sx * 0.36, 1.5, 0);   // hombreras
    }
    // cabeza, rostro, bigote o pañuelo
    add(new THREE.CylinderGeometry(0.07, 0.08, 0.1, 8), skin, 0, 1.6, 0);
    add(new THREE.SphereGeometry(0.17, 14, 12), skin, 0, 1.74, 0);
    for (const sx of [-1, 1]) add(new THREE.SphereGeometry(0.022, 6, 6), dark, sx * 0.066, 1.77, 0.15);
    add(new THREE.BoxGeometry(0.04, 0.05, 0.04), skin, 0, 1.73, 0.17);
    if (type === 'bandit') {
      add(new THREE.CylinderGeometry(0.178, 0.178, 0.1, 12, 1, true), M(T.band), 0, 1.68, 0);          // pañuelo sobre la cara
      add(new THREE.BoxGeometry(0.3, 0.2, 0.03), M(T.band), 0, 1.64, 0.14, g, [0.25, 0, 0]);
    } else {
      add(new THREE.BoxGeometry(0.15, 0.035, 0.04), dark, 0, 1.69, 0.165);                              // bigote
      if (big) add(new THREE.SphereGeometry(0.15, 8, 6), dark, 0, 1.62, 0.07);                           // barba
      if (long) { add(new THREE.CylinderGeometry(0.178, 0.178, 0.06, 12, 1, true), M(T.band), 0, 1.6, 0); }
    }
    // sombrero (ala + copa + cinta)
    const brim = long ? 0.42 : big ? 0.34 : 0.36;
    add(new THREE.CylinderGeometry(brim, brim, 0.025, 20), M(T.hat), 0, 1.85, 0);
    add(new THREE.CylinderGeometry(0.15, 0.19, big ? 0.24 : 0.19, 14), M(T.hat), 0, big ? 1.97 : 1.95, 0);
    add(new THREE.CylinderGeometry(0.193, 0.193, 0.045, 14), M(T.band), 0, 1.89, 0);
    // brazos y armas
    const arm = (sx, rx, ry, rz) => {
      const pv = new THREE.Group(); pv.position.set(sx * 0.34, 1.5, 0); pv.rotation.order = 'YXZ'; pv.rotation.set(rx, ry, rz); g.add(pv);
      add(new THREE.CapsuleGeometry(0.075, 0.5, 4, 8), M(T.shirt), 0, -0.3, 0, pv);
      add(new THREE.SphereGeometry(0.075, 8, 6), skin, 0, -0.66, 0, pv);
      return pv;
    };
    if (type === 'bandit') {                                  // revólver a una mano
      arm(1, -1.35, 0, 0); arm(-1, 0.08, 0, -0.12);
      add(new THREE.BoxGeometry(0.05, 0.06, 0.3), steel, 0.34, 1.4, 0.82);
      add(new THREE.BoxGeometry(0.045, 0.13, 0.06), leather, 0.34, 1.33, 0.67, g, [0.3, 0, 0]);
    } else {                                                   // arma larga a dos manos
      arm(1, -1.3, -0.3, 0); arm(-1, -1.3, 0.35, 0);
      const L = long ? 1.25 : 0.95, th = long ? 0.045 : 0.07;
      add(new THREE.BoxGeometry(th, th, L), steel, 0.02, 1.4, 0.65 + L / 2 - 0.2);
      add(new THREE.BoxGeometry(th * 1.4, th * 2.2, 0.32), M(0x5a3a22), 0.02, 1.38, 0.5, g, [0.1, 0, 0]);   // culata
    }
    g.scale.setScalar(T.sc);
    const e = { type, T, sc: T.sc, dmg: T.dmg, spd: T.spd, range: T.range, keep: T.keep, cdR: T.cd, pts: T.pts, tr: T.tr, g, mm, legs, hp: T.hp, cd: R(1.5, 3), los: true, losT: 0, vx: 0, vz: 0, aimT: 0, strafeT: R(0.5, 2), aimDur: type === 'rifle' ? 0.6 : type === 'brute' ? 0.45 : 0.35, acc: type === 'rifle' ? 0.75 : type === 'brute' ? 0.5 : 0.55, side: Math.random() < .5 ? 1 : -1, state: 'live', t: 0, flash: 0, ph: R(0, 6) };
    g.userData.enemy = e;
    return e;
  }
  function spawnEnemy() {
    const e = makeEnemy(pickType()), [x, z] = far(20, 1.2), Lv = level() - 1;
    e.hp += e.type === 'brute' ? Math.floor(Lv * 0.6) : (Lv >= 8 ? 1 : 0);   // más resistentes con el nivel
    e.spd *= Math.min(1.4, 1 + 0.04 * Lv);                                    // más rápidos
    e.dmg *= Math.min(2, 1 + 0.06 * Lv);                                      // más daño
    e.acc *= Math.min(1.45, 1 + 0.035 * Lv);                                  // mejor puntería
    e.cdR = e.cdR.map((c) => c * Math.max(0.55, 1 - 0.04 * Lv));              // disparan más seguido
    e.aimDur *= Math.max(0.6, 1 - 0.03 * Lv);                                 // apuntan más rápido
    e.g.position.set(x, 0, z);
    scene.add(e.g); enemies.push(e);
    burst(new THREE.Vector3(x, 0.5, z), 0xd9a441, 8);
  }

  function hurt(d) {
    if (S.over || S.inv > 0) return;
    S.inv = INV_TIME;   // breve invulnerabilidad tras cada impacto
    S.regen = REGEN_DELAY;
    S.hp = Math.max(0, S.hp - d);
    S.hurt = 1;
    tone(120, 0.35, 'sawtooth', 0.35, 50); haptic(1, 200);
    if (S.hp <= 0) {
      S.over = 1; S.deadT = 0; tone(80, 1, 'sawtooth', 0.4, 30);
      showDeath(true);
      if (document.pointerLockElement) document.exitPointerLock();
    }
  }
  function damage(e, d, p, hand) {
    if (e.state !== 'live') return;
    e.hp -= d; e.flash = 0.15;
    burst(p, 0xc8140a); tone(900, 0.08, 'square', 0.2, 500); haptic(0.6, 80, hand);
    if (e.hp <= 0) {
      e.state = 'dying'; e.t = 0; S.score += Math.round((d >= 3 ? 150 : 100) * e.pts);
      tone(300, 0.4, 'sawtooth', 0.2, 60); burst(p, 0xffd27a, 16);
    }
  }

  // Disparo (desde la cámara en pantalla o desde el control en VR): daña enemigos
  function shootRay(ray, hand, maxD = 90) {
    if (S.over) return null;
    rc.ray.copy(ray); rc.far = maxD;
    const hit = rc.intersectObjects(enemies.filter((e) => e.state === 'live').map((e) => e.g), true)[0];
    if (!hit) return null;
    let o = hit.object;
    while (o && !o.userData.enemy) o = o.parent;
    if (o) damage(o.userData.enemy, hit.point.y > 1.55 * o.userData.enemy.sc ? 3 : 1, hit.point, hand); // cabeza = muerte directa
    return hit.point;
  }

  /* ---------- Controles de mano: gatillo = disparar ---------- */
  function fire(c) {
    if (cd > 0 || S.over || !live) return;
    cd = CONFIG.shootCooldown;
    const o = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(c.matrixWorld)).normalize();
    rc.set(o, d); rc.far = 90;
    const wl = rc.intersectObjects(town.blockers, false)[0], wd = wl ? wl.distance : 90;
    const p = shootRay(new THREE.Ray(o, d), c.userData.hand, wd);
    rc.set(o, d); rc.far = wd;
    const h = rc.intersectObjects(dynamics.map((x) => x.mesh), true)[0];
    if (h) {
      const dd = dynamics.find((x) => { for (let q = h.object; q; q = q.parent) if (q === x.mesh) return true; });
      if (dd) {
        dd.body.wakeUp();
        const k = dd.body.mass * CONFIG.shotSpeed;
        dd.body.applyImpulse(new CANNON.Vec3(d.x * k, d.y * k + dd.body.mass, d.z * k),
          new CANNON.Vec3(h.point.x - dd.body.position.x, h.point.y - dd.body.position.y, h.point.z - dd.body.position.z));
      }
    }
    tracer(o.clone().addScaledVector(d, 0.25), p || (h && h.point) || o.clone().addScaledVector(d, wl ? wd : 40));
    C.playShot(); haptic(0.5, 60, c.userData.hand);
  }
  const iron = new THREE.MeshStandardMaterial({ color: 0x24201c, metalness: 0.7, roughness: 0.5 });
  [0, 1].forEach((i) => {
    const c = renderer.xr.getController(i);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.22), iron); barrel.position.z = -0.12;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.1, 0.04), iron); grip.position.set(0, -0.05, 0.01);
    const laser = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -0.25), new THREE.Vector3(0, 0, -8)]),
      new THREE.LineBasicMaterial({ color: 0xd9a441, transparent: true, opacity: 0.35, fog: false }));
    c.add(barrel, grip, laser);
    c.addEventListener('connected', (e) => { c.userData.hand = e.data.handedness; });
    c.addEventListener('selectstart', () => fire(c));
    rig.add(c);
  });

  /* ---------- Botiquines: al tomarlos desaparecen y, unos segundos después, reaparecen en OTRO lugar ---------- */
  const picks = [];
  const crossMat = new THREE.MeshBasicMaterial({ color: 0xc8140a });
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.3), new THREE.MeshStandardMaterial({ color: 0xead9b0, roughness: 0.6 })),
      new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.31), crossMat),
      new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.26, 0.31), crossMat));
    g.position.set(0, 0.6, 0); g.userData.wait = 0; g.userData.born = -99;
    scene.add(g); picks.push(g);
  }
  // Nuevo punto: lejos del jugador, de su lugar anterior, de otros botiquines y SIEMPRE fuera de obstáculos
  // (antes podía caer dentro de una roca o del saloon y era imposible recogerlo)
  function placePick(p) {
    const old = p.position.clone();
    let best = null;
    for (let i = 0; i < 40 && !best; i++) {
      const [x, z] = far(10, 1.2);
      if (Math.hypot(x - old.x, z - old.z) < 15) continue;
      if (picks.some((q) => q !== p && q.visible && Math.hypot(q.position.x - x, q.position.z - z) < 12)) continue;
      best = [x, z];
    }
    if (!best) best = far(10, 1.2);
    p.position.set(best[0], 0.6, best[1]);
  }

  /* ---------- Escenario ampliado ---------- */
  function scenery() {
    const rockM = new THREE.MeshStandardMaterial({ color: 0x8a7f72, roughness: 1, flatShading: true });
    const deadM = C.woodMat(1, 3, 0x6b5a48);
    for (let i = 0; i < 9; i++) { // árboles secos
      const [x, z] = far(7, 1, true), t = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, 3.6, 6), deadM); trunk.position.y = 1.8;
      t.add(trunk);
      for (let k = 0; k < 3; k++) {
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.08, 1.4, 5), deadM);
        b.position.set(Math.sin(k * 2.1) * 0.5, 2.6 + k * 0.3, Math.cos(k * 2.1) * 0.5);
        b.rotation.set(Math.cos(k * 2.1) * 0.9, 0, -Math.sin(k * 2.1) * 0.9);
        t.add(b);
      }
      t.position.set(x, 0, z); t.rotation.y = R(0, 6);
      t.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      scene.add(t); C.addStaticBox(x, 1.8, z, 0.25, 1.8, 0.25); mapObjs.trees.push([x, z]);
    }
    for (let i = 0; i < 8; i++) { // formaciones rocosas
      const s = R(1, 2.2), [x, z] = far(9, s + 0.5, true);
      const r = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), rockM);
      r.scale.y = 0.7; r.position.set(x, s * 0.5, z); r.rotation.y = R(0, 6);
      r.castShadow = r.receiveShadow = true; scene.add(r);
      C.addStaticBox(x, s * 0.5, z, s * 0.7, s * 0.5, s * 0.7); mapObjs.rocks.push([x, z, s]);
    }
    for (let i = 0; i < 14; i++) { // mesetas lejanas para dar profundidad
      const a = (i / 14) * Math.PI * 2, d = R(56, 68), ww = R(8, 16), h = R(8, 22);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(ww * 0.7, ww, h, 7),
        new THREE.MeshStandardMaterial({ color: 0x7a5a45, roughness: 1, flatShading: true }));
      m.position.set(Math.cos(a) * d, h / 2, Math.sin(a) * d); scene.add(m);
    }
  }
  // Objetos físicos (barriles, rocas, pelota) en posiciones aleatorias; la pirámide de cajas queda fija
  function scatter() {
    dynamics.slice(6, -1).forEach((d) => {
      const [x, z] = far(6, 1.0);
      d.body.position.set(x, d.body.position.y, z);
      d.home.p.set(x, d.body.position.y, z);
    });
  }
  /* ---------- MINIMAPA (radar estilo RDR2): gira con la vista, muestra enemigos y botiquines ---------- */
  const mapObjs = { trees: [], rocks: [], wagon: null };
  const MS = 320, MR = 138, RANGE = 40, BGN = 704, BGK = BGN / 88, LINE = '#3d4540';
  const MFONT = '30px RDR, "Rubik Dirt", Impact, sans-serif';
  const mmCv = document.createElement('canvas');
  mmCv.width = mmCv.height = MS;
  const mg = mmCv.getContext('2d');
  const mmTex = new THREE.CanvasTexture(mmCv);
  mmTex.colorSpace = THREE.SRGBColorSpace;
  const mmMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2),
    new THREE.MeshBasicMaterial({ map: mmTex, transparent: true, depthTest: false, fog: false }));
  mmMesh.renderOrder = 999; mmMesh.frustumCulled = false;
  camera.add(mmMesh);

  // Mapa de fondo (se dibuja una sola vez): papel color arena con las construcciones reales del escenario
  const bg = document.createElement('canvas');
  bg.width = bg.height = BGN;
  function buildMapBG() {
    const g = bg.getContext('2d'), H = CONFIG.arenaHalf - 0.6;
    g.fillStyle = '#a98a5a'; g.fillRect(0, 0, BGN, BGN);
    g.translate(BGN / 2, BGN / 2); g.scale(BGK, BGK);
    g.fillStyle = '#c9a877'; g.fillRect(-H, -H, H * 2, H * 2);
    for (let i = 0; i < 3000; i++) { g.fillStyle = `rgba(90,60,30,${R(0.03, 0.09)})`; g.fillRect(R(-H, H), R(-H, H), 0.25, 0.25); }
    g.strokeStyle = 'rgba(61,69,64,.28)'; g.lineWidth = 1.5 / BGK;
    for (let k = -30; k <= 30; k += 10) { g.beginPath(); g.moveTo(k, -H); g.lineTo(k, H); g.moveTo(-H, k); g.lineTo(H, k); g.stroke(); }
    g.strokeStyle = LINE; g.lineWidth = 4 / BGK; g.strokeRect(-H, -H, H * 2, H * 2);   // la cerca
    g.lineWidth = 2.5 / BGK;
    g.lineCap = g.lineJoin = 'round';
    for (const r of town.roads) {                                                            // caminos de tierra
      g.strokeStyle = '#b89a68'; g.lineWidth = r.w;
      g.beginPath(); r.p.forEach(([x, z], k) => g[k ? 'lineTo' : 'moveTo'](x, z)); g.stroke();
    }
    for (const r of town.rails) {                                                            // vía del tren
      g.strokeStyle = LINE; g.lineWidth = 0.35; g.beginPath(); g.moveTo(r.x - 0.7, r.z0); g.lineTo(r.x - 0.7, r.z1); g.moveTo(r.x + 0.7, r.z0); g.lineTo(r.x + 0.7, r.z1); g.stroke();
      g.setLineDash([0.25, 0.55]); g.lineWidth = 1.8; g.globalAlpha = .5; g.beginPath(); g.moveTo(r.x, r.z0); g.lineTo(r.x, r.z1); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    }
    g.lineWidth = 2.5 / BGK; g.strokeStyle = LINE;
    for (const b of town.buildings) {                                                        // edificios (con su porche)
      g.save(); g.translate(b.x, b.z); g.rotate(-b.rot);
      if (b.porch) { g.fillStyle = '#c4a574'; g.fillRect(-b.w / 2, b.d / 2, b.w, b.porch); }
      g.fillStyle = b.stone ? '#9b948a' : b.big ? '#b97a45' : '#a8895a';
      g.fillRect(-b.w / 2, -b.d / 2, b.w, b.d); g.strokeRect(-b.w / 2, -b.d / 2, b.w, b.d);
      g.restore();
    }
    g.fillStyle = '#a8895a';
    for (const p of town.props) {
      if (p.t === 'tower') { g.fillStyle = '#4a7aa8'; g.beginPath(); g.arc(p.x, p.z, 1.6, 0, 7); g.fill(); g.stroke(); g.fillStyle = '#a8895a'; }
      else if (p.t === 'cart') { g.save(); g.translate(p.x, p.z); g.rotate(-p.rot); g.fillRect(-.8, -1.5, 1.6, 3); g.strokeRect(-.8, -1.5, 1.6, 3); g.restore(); }
      else if (p.t === 'box') { g.fillRect(p.x - p.w / 2, p.z - p.d / 2, p.w, p.d); g.strokeRect(p.x - p.w / 2, p.z - p.d / 2, p.w, p.d); }
      else if (p.t === 'station') { g.fillStyle = '#c4a574'; g.fillRect(-29.7, -8.6, 6.85, 14); g.strokeRect(-29.7, -8.6, 6.85, 14); g.fillStyle = '#a8895a'; }
    }
    g.fillStyle = LINE;
    g.beginPath(); g.arc(10.5, 3.2, 1, 0, 7); g.stroke();                                    // fogata
    g.beginPath(); g.arc(-2.5, -1, 0.5, 0, 7); g.fill();                                     // farol
    for (const [x, z] of mapObjs.trees) { g.beginPath(); g.arc(x, z, 0.5, 0, 7); g.fill(); }
    g.fillStyle = '#a68758';
    for (const [x, z, r] of mapObjs.rocks) { g.beginPath(); g.arc(x, z, r * 0.8, 0, 7); g.fill(); g.stroke(); }
    if (mapObjs.wagon) {
      const [x, z, ry] = mapObjs.wagon;
      g.save(); g.translate(x, z); g.rotate(-ry); g.fillRect(-1.5, -0.7, 3, 1.4); g.strokeRect(-1.5, -0.7, 3, 1.4); g.restore();
    }
  }

  const mmF = new THREE.Vector3();
  function drawMinimap() {
    camera.getWorldDirection(mmF);
    const l = Math.hypot(mmF.x, mmF.z) || 1, fx = mmF.x / l, fz = mmF.z / l;
    const th = -Math.PI / 2 - Math.atan2(fz, fx);            // el frente del jugador queda hacia arriba
    const cs = Math.cos(th), sn = Math.sin(th), c = MS / 2, s = MR / RANGE;
    const px = heroBody.position.x, pz = heroBody.position.z;
    mg.clearRect(0, 0, MS, MS);

    mg.save();
    mg.beginPath(); mg.arc(c, c, MR, 0, Math.PI * 2); mg.clip();
    mg.fillStyle = '#a98a5a'; mg.fillRect(0, 0, MS, MS);
    mg.translate(c, c); mg.rotate(th); mg.scale(s / BGK, s / BGK);
    mg.drawImage(bg, -BGN / 2 - px * BGK, -BGN / 2 - pz * BGK);
    mg.restore();

    // Iconos (pasan al borde del radar cuando están fuera de alcance)
    mg.save();
    mg.beginPath(); mg.arc(c, c, MR, 0, Math.PI * 2); mg.clip();
    const vg = mg.createRadialGradient(c, c, MR * 0.6, c, c, MR);
    vg.addColorStop(0, 'rgba(60,40,20,0)'); vg.addColorStop(1, 'rgba(60,40,20,.38)');
    mg.fillStyle = vg; mg.fillRect(0, 0, MS, MS);
    const pos = (wx, wz) => {
      const dx = (wx - px) * s, dz = (wz - pz) * s;
      let x = dx * cs - dz * sn, y = dx * sn + dz * cs;
      const d = Math.hypot(x, y), edge = d > MR - 12;
      if (edge) { x *= (MR - 12) / d; y *= (MR - 12) / d; }
      return [c + x, c + y, edge];
    };
    for (const p of picks) {                                   // botiquines: círculo negro con cruz blanca
      if (!p.visible) continue;                                // recogido: desaparece del radar
      const [x, y, e] = pos(p.position.x, p.position.z), r = e ? 6 : 9;
      const age = nowT - p.userData.born;
      if (age < 3) {                                           // acaba de reaparecer: aro que se expande
        const k = age % 1;
        mg.strokeStyle = `rgba(255,255,255,${1 - k})`; mg.lineWidth = 3;
        mg.beginPath(); mg.arc(x, y, r + k * 16, 0, 7); mg.stroke();
      }
      mg.fillStyle = '#120a07'; mg.beginPath(); mg.arc(x, y, r, 0, 7); mg.fill();
      mg.fillStyle = '#ffffff'; mg.fillRect(x - r * 0.6, y - r * 0.18, r * 1.2, r * 0.36); mg.fillRect(x - r * 0.18, y - r * 0.6, r * 0.36, r * 1.2);
    }
    for (const e of enemies) {                                 // enemigos: círculo rojo con borde oscuro
      if (e.state !== 'live') continue;
      const [x, y, edge] = pos(e.g.position.x, e.g.position.z), r = edge ? 5 : 8;
      mg.fillStyle = '#c8140a'; mg.strokeStyle = '#120a07'; mg.lineWidth = 3;
      mg.beginPath(); mg.arc(x, y, r, 0, 7); mg.stroke(); mg.fill();
      mg.fillStyle = '#ffd9a8'; mg.beginPath(); mg.arc(x, y, r * 0.3, 0, 7); mg.fill();
    }
    mg.restore();

    // Letras N · E · S · W (giran con el mapa)
    mg.font = MFONT; mg.textAlign = 'center'; mg.textBaseline = 'middle'; mg.fillStyle = '#120a07';
    for (const [ch, dx, dz] of [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]]) {
      mg.fillText(ch, c + (dx * cs - dz * sn) * (MR - 24), c + (dx * sn + dz * cs) * (MR - 24));
    }

    // Jugador: marcador blanco apuntando al frente (siempre arriba)
    mg.fillStyle = '#ffffff'; mg.strokeStyle = '#120a07'; mg.lineWidth = 3; mg.lineJoin = 'round';
    mg.beginPath(); mg.moveTo(c - 9, c - 4); mg.lineTo(c, c - 23); mg.lineTo(c + 9, c - 4); mg.closePath(); mg.stroke(); mg.fill();
    mg.beginPath(); mg.arc(c, c, 10, 0, 7); mg.stroke(); mg.fill();
    mg.fillStyle = LINE; mg.beginPath(); mg.arc(c, c, 4.5, 0, 7); mg.fill();

    // Aro negro grueso, marcas de los 8 rumbos y flecha al norte (fijas, como en el juego)
    mg.strokeStyle = '#0d0a08'; mg.lineCap = 'butt';
    mg.lineWidth = 14; mg.beginPath(); mg.arc(c, c, MR + 7, 0, Math.PI * 2); mg.stroke();
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4 - Math.PI / 2, card = k % 2 === 0;
      const r0 = MR - (card ? 6 : 3), r1 = card ? MS / 2 - 2 : MR + 17;
      mg.lineWidth = card ? 6 : 5;
      mg.beginPath(); mg.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0); mg.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1); mg.stroke();
    }
    mg.fillStyle = '#0d0a08';
    mg.beginPath(); mg.moveTo(c - 12, 16); mg.lineTo(c, 0); mg.lineTo(c + 12, 16); mg.closePath(); mg.fill();
    mmTex.needsUpdate = true;
  }

  scenery(); scatter(); picks.forEach(placePick); buildMapBG();

  /* ---------- Pantalla de muerte: FALLASTE · Volver a jugar · Salir ----------
     PC: Enter / Esc · Meta Quest: A (o X) / B (o Y). Misma estética que el menú de pausa de RDR2. */
  const deathBG = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false }));
  deathBG.position.z = -0.25; deathBG.renderOrder = 1000; deathBG.frustumCulled = false; deathBG.visible = false;
  const dcv = document.createElement('canvas');
  dcv.width = 1920; dcv.height = 1080;
  const dtex = new THREE.CanvasTexture(dcv);
  dtex.colorSpace = THREE.SRGBColorSpace;
  const deathP = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: dtex, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false }));
  deathP.position.z = -0.9; deathP.renderOrder = 1001; deathP.frustumCulled = false; deathP.visible = false;
  camera.add(deathBG, deathP);
  let dAsp = 0;
  // El cartel cubre toda la pantalla (PC) o un panel frente a la vista (VR); el lienzo sigue la proporción
  function layoutDeath() {
    const asp = deathVR ? 16 / 9 : (camera.aspect || 16 / 9);
    dAsp = asp + (deathVR ? 100 : 0);
    dcv.height = 1080; dcv.width = Math.round(1080 * asp);
    if (deathVR) { deathP.position.z = -1.1; deathP.scale.set(1.5, 1.5 / asp, 1); }
    else {
      const h = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 0.9;
      deathP.position.z = -0.9; deathP.scale.set(h * asp, h, 1);
    }
    drawDeath();
  }

  const DFF = 'RDR, "Rubik Dirt", Impact, sans-serif';
  // Botón redondo gris claro (como en el menú de pausa): ↵, ESC, A o B. Devuelve su ancho.
  function keycap(g, kind, x, y) {
    const h = 56, r = h / 2, w = kind === 'esc' ? 108 : h;
    g.save();
    g.shadowColor = 'rgba(0,0,0,.65)'; g.shadowBlur = 10; g.shadowOffsetY = 3;
    g.fillStyle = '#ececec';
    g.beginPath();
    g.moveTo(x + r, y - r); g.lineTo(x + w - r, y - r); g.arc(x + w - r, y, r, -Math.PI / 2, Math.PI / 2);
    g.lineTo(x + r, y + r); g.arc(x + r, y, r, Math.PI / 2, Math.PI * 1.5); g.closePath(); g.fill();
    g.restore();
    g.strokeStyle = '#161616'; g.fillStyle = '#161616'; g.lineCap = 'round'; g.lineJoin = 'round';
    const cx = x + w / 2;
    if (kind === 'enter') {            // símbolo ↵
      g.lineWidth = 4.5;
      g.beginPath(); g.moveTo(cx + 10, y - 12); g.lineTo(cx + 10, y + 5); g.lineTo(cx - 10, y + 5); g.stroke();
      g.beginPath(); g.moveTo(cx - 5, y - 1); g.lineTo(cx - 11, y + 5); g.lineTo(cx - 5, y + 11); g.stroke();
    } else {
      g.font = `30px ${DFF}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(kind === 'esc' ? 'ESC' : kind, cx, y + 2);
    }
    return w;
  }

  function drawDeath() {
    const g = dcv.getContext('2d'), HD = 540, k = dcv.height / HD, WD = dcv.width / k;   // unidades de diseño: alto 540
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, dcv.width, dcv.height);
    g.setTransform(k, 0, 0, k, 0, 0);
    // Título al centro
    g.textAlign = 'center'; g.textBaseline = 'middle';
    let fs = 190;
    g.font = `${fs}px ${DFF}`;
    while (g.measureText('FALLASTE').width > WD * 0.7 && fs > 60) { fs -= 6; g.font = `${fs}px ${DFF}`; }
    g.fillStyle = '#b3120c'; g.fillText('FALLASTE', WD / 2, HD * 0.45);
    g.globalCompositeOperation = 'destination-out';           // desgaste de la tipografía
    for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(0,0,0,${R(0.4, 0.9)})`; g.fillRect(R(WD * 0.15, WD * 0.85), R(HD * 0.25, HD * 0.65), R(1, 4), R(1, 4)); }
    g.globalCompositeOperation = 'source-over';
    // Puntos: esquina superior izquierda
    g.textAlign = 'left'; g.font = `28px ${DFF}`; g.lineJoin = 'round'; g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,.92)';
    const pt = `PUNTOS  ${S.score}`;
    g.strokeText(pt, 36, 44); g.fillStyle = '#ead9b0'; g.fillText(pt, 36, 44);

    // Opciones: esquina inferior derecha (PC: ↵ y ESC · VR: A y B)
    const items = deathVR ? [['VOLVER A JUGAR', 'A'], ['SALIR', 'B']] : [['VOLVER A JUGAR', 'enter'], ['SALIR', 'esc']];
    const y = HD - 40, GAP = 34, PAD = 10, KS = 0.62, FS = 22;
    g.font = `${FS}px ${DFF}`;
    const kw = (kind) => (kind === 'esc' ? 108 : 56) * KS;
    const widths = items.map(([label, kind]) => g.measureText(label).width + PAD + kw(kind));
    let x = WD - 36 - (widths.reduce((a, c) => a + c, 0) + GAP * (items.length - 1));
    items.forEach(([label, kind], i) => {
      g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = `${FS}px ${DFF}`;
      g.lineJoin = 'round'; g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,.92)';
      g.strokeText(label, x, y); g.fillStyle = '#ffffff'; g.fillText(label, x, y);
      g.save(); g.translate(x + g.measureText(label).width + PAD, y); g.scale(KS, KS); keycap(g, kind, 0, 0); g.restore();
      x += widths[i] + GAP;
    });
    dtex.needsUpdate = true;
  }
  const hideCss = document.createElement('style');
  hideCss.textContent = 'body.fallaste #crosshair, body.fallaste #stage > div[style*="z-index: 5"] { display: none !important; }';
  document.head.appendChild(hideCss);
  function showDeath(on) {
    document.body.classList.toggle('fallaste', !!on);
    deathBG.visible = deathP.visible = on;
    deathBG.material.opacity = deathP.material.opacity = 0;
    if (on) { deathVR = renderer.xr.isPresenting; layoutDeath(); }
  }

  /* ---------- Reinicio ---------- */
  function restart() {
    lastLvl = 1; S.hp = MAXHP; S.score = 0; S.over = 0; S.inv = 1.5; S.deadT = 0; S.regen = 0; S.msgT = 0; S.hurt = 0;
    showDeath(false);
    enemies.splice(0).forEach((e) => scene.remove(e.g));
    picks.forEach((p) => { p.visible = true; p.userData.wait = 0; p.userData.born = -99; placePick(p); });
    scatter(); C.resetObjects();
    heroBody.position.set(2, 0.95, 2.5); heroBody.velocity.setZero();
  }
  const retry = () => { restart(); C.lockMouse(); };
  const quit = () => { restart(); renderer.xr.getSession()?.end(); C.goHome(); };
  // Teclado (PC): Enter = volver a jugar · Esc = salir. Se captura antes que el resto del juego.
  window.addEventListener('keydown', (e) => {
    if (!S.over) return;
    e.stopImmediatePropagation(); e.preventDefault();
    if (S.deadT < 0.8 || e.repeat) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') retry(); else if (e.code === 'Escape') quit();
  }, true);
  // Controles Meta Quest: A (o X) = volver a jugar · B (o Y) = salir
  let prevA = true, prevB = true;
  function pollDeathButtons() {
    let A = false, B = false;
    for (const src of renderer.xr.getSession()?.inputSources || []) {
      const b = src.gamepad?.buttons;
      if (!b) continue;
      if (b[4]?.pressed) A = true;
      if (b[5]?.pressed) B = true;
    }
    if (S.deadT > 0.8) { if (A && !prevA) { prevA = prevB = true; return retry(); } if (B && !prevB) { prevA = prevB = true; return quit(); } }
    prevA = A; prevB = B;
  }

  /* ---------- Locomoción VR: stick izq. mueve (grip = correr), stick der. gira 45°, A salta ---------- */
  const f = new THREE.Vector3();
  function vrMove() {
    rig.position.set(heroBody.position.x, heroBody.position.y - C.HERO_FEET, heroBody.position.z);
    let mx = 0, mz = 0, run = false;
    for (const src of renderer.xr.getSession().inputSources) {
      const a = src.gamepad?.axes, b = src.gamepad?.buttons;
      if (!a || a.length < 4) continue;
      if (src.handedness === 'left') { mx = a[2]; mz = -a[3]; run = !!b[1]?.pressed; }
      if (src.handedness === 'right') {
        if (Math.abs(a[2]) > 0.7 && !snap) { rig.rotation.y -= Math.sign(a[2]) * Math.PI / 4; snap = true; }
        else if (Math.abs(a[2]) < 0.3) snap = false;
        if (b[4]?.pressed && C.isGrounded()) heroBody.velocity.y = CONFIG.jumpSpeed;
      }
    }
    if (Math.hypot(mx, mz) < 0.15) mx = mz = 0;
    camera.getWorldDirection(f); f.y = 0; f.normalize();
    const sp = run ? CONFIG.runSpeed : CONFIG.walkSpeed;
    heroBody.velocity.x = (f.x * mz - f.z * mx) * sp;
    heroBody.velocity.z = (f.z * mz + f.x * mx) * sp;
    const lim = CONFIG.arenaHalf - 1.2;
    heroBody.position.x = THREE.MathUtils.clamp(heroBody.position.x, -lim, lim);
    heroBody.position.z = THREE.MathUtils.clamp(heroBody.position.z, -lim, lim);
  }

  /* ---------- Bucle del juego ---------- */
  function update(dt, t, inVR, running) {
    live = running; nowT = t;
    cd = Math.max(0, cd - dt);
    const hp0 = heroBody.position;

    if (inVR) { wasVR = true; hero.group.visible = false; if (running && !S.over) vrMove(); }
    S.hurt = Math.max(0, S.hurt - dt * 1.8); S.inv = Math.max(0, S.inv - dt);
    if (level() !== lastLvl) {
      if (level() > lastLvl) { S.msg = `¡NIVEL ${level()}!`; S.msgT = 2.5; S.msgC = '#ffb84a'; tone(330, 0.25, 'triangle', 0.2, 660); }
      lastLvl = level();
    }
    S.msgT = Math.max(0, S.msgT - dt);
    flash.material.opacity = S.hurt * 0.55;

    if (running) {
      if (S.over) {                      // pantalla FALLASTE: el mundo se congela y se espera una opción
        S.deadT += dt; heroBody.velocity.x = heroBody.velocity.z = 0;
        const k = Math.min(1, S.deadT / 1.2);
        deathBG.material.opacity = 0.96 * k; deathP.material.opacity = k;
        if (deathVR !== inVR) { deathVR = inVR; layoutDeath(); }
        else if (dAsp !== (deathVR ? 16 / 9 + 100 : (camera.aspect || 16 / 9))) layoutDeath();   // muestra ↵/ESC en PC y A/B en VR
        if (inVR) pollDeathButtons();
      }
      else {
        // recuperación lenta de vida si llevas un rato sin recibir daño
        S.regen = Math.max(0, S.regen - dt);
        if (S.regen === 0 && S.hp < MAXHP) S.hp = Math.min(MAXHP, S.hp + REGEN_RATE * dt);

        // aparición aleatoria de enemigos (más conforme sube el puntaje)
        spawnT -= dt;
        const alive = enemies.filter((e) => e.state === 'live').length;
        if (spawnT <= 0 && alive < Math.min(MAX_ENEMIES[1], MAX_ENEMIES[0] + level() - 1)) { spawnEnemy(); spawnT = Math.max(0.6, 1.6 - 0.08 * (level() - 1)); }

        if (!gready) navInit();
        gT -= dt;
        if (gT <= 0 || nearestFree(hp0.x, hp0.z) !== gSrc) { gT = 0.3; flowFrom(hp0.x, hp0.z); }
        for (const e of enemies) {
          if (e.state === 'dying') {
            e.t += dt; e.g.rotation.x = -Math.min(1, e.t / 0.4) * Math.PI / 2;
            if (e.t > 1.6) e.state = 'gone';
            continue;
          }
          const dx = hp0.x - e.g.position.x, dz = hp0.z - e.g.position.z, d = Math.hypot(dx, dz) || 1;
          // giro suave hacia el jugador
          let dy = Math.atan2(dx, dz) - e.g.rotation.y;
          dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          e.g.rotation.y += dy * Math.min(1, dt * 9);
          e.losT -= dt;
          if (e.losT <= 0) {            // ¿hay línea de tiro libre hasta el jugador? (los edificios la bloquean)
            e.losT = 0.2;
            const a = new THREE.Vector3(e.g.position.x, 1.3, e.g.position.z), b = new THREE.Vector3(hp0.x, hp0.y + 0.4, hp0.z);
            rc.set(a, b.clone().sub(a).normalize()); rc.far = a.distanceTo(b);
            e.los = !rc.intersectObjects(town.blockers, false).length;
          }
          e.cd -= dt;
          const ready = e.los && d < e.range;
          if (ready && e.cd <= 0 && e.aimT <= 0) e.aimT = e.aimDur;      // apunta un instante antes de disparar
          if (!ready) e.aimT = 0;
          const aiming = e.aimT > 0;

          // --- movimiento deseado ---
          let wx = 0, wz = 0;
          if (aiming) { /* quieto mientras apunta */ }
          else if (!e.los || d > e.keep + 5) {                         // sin línea de tiro o lejos: sigue el camino
            const tg = navTarget(e.g.position.x, e.g.position.z, hp0.x, hp0.z);
            const tx = tg ? tg[0] - e.g.position.x : dx, tz = tg ? tg[1] - e.g.position.z : dz, td = Math.hypot(tx, tz) || 1;
            wx = tx / td * e.spd; wz = tz / td * e.spd;
          } else {                                                     // en combate: mantiene distancia y se mueve de lado
            e.strafeT -= dt;
            if (e.strafeT <= 0) { e.side = -e.side; e.strafeT = R(1.2, 2.8); }
            const rad = THREE.MathUtils.clamp((d - e.keep) * 0.6, -e.spd, e.spd);   // acercarse / alejarse
            const nxp = dx / d, nzp = dz / d;
            wx = nxp * rad + (-nzp) * e.side * e.spd * 0.65;
            wz = nzp * rad + nxp * e.side * e.spd * 0.65;
          }
          for (const o of enemies) {                                   // separación entre bandidos
            if (o === e || o.state !== 'live') continue;
            const sx = e.g.position.x - o.g.position.x, sz = e.g.position.z - o.g.position.z, sd = Math.hypot(sx, sz);
            if (sd > 0.01 && sd < 1.1) { wx += sx / sd * (1.1 - sd) * 2.5; wz += sz / sd * (1.1 - sd) * 2.5; }
          }
          e.vx += (wx - e.vx) * Math.min(1, dt * 7); e.vz += (wz - e.vz) * Math.min(1, dt * 7);   // aceleración suave
          {
            const ex = e.g.position.x, ez = e.g.position.z;
            let nx = ex + e.vx * dt, nz = ez + e.vz * dt;
            if (!gfree(gi(nx), gi(nz)) && gfree(gi(ex), gi(ez))) {      // nunca entra en una estructura: desliza por un eje
              if (gfree(gi(nx), gi(ez))) { nz = ez; e.vz = 0; } else if (gfree(gi(ex), gi(nz))) { nx = ex; e.vx = 0; } else { nx = ex; nz = ez; e.vx = e.vz = 0; e.side = -e.side; }
            }
            e.g.position.x = THREE.MathUtils.clamp(nx, -L - 2, L + 2);
            e.g.position.z = THREE.MathUtils.clamp(nz, -L - 2, L + 2);
          }
          const spd = Math.hypot(e.vx, e.vz);
          e.ph += spd * dt * 4;
          const sw = Math.min(1, spd / 1.5);
          e.legs[0].rotation.x = Math.sin(e.ph) * 0.7 * sw;
          e.legs[1].rotation.x = -Math.sin(e.ph) * 0.7 * sw;
          e.flash -= dt;
          e.mm.forEach((m) => m.emissive.setHex(e.flash > 0 ? 0xaa2200 : (aiming ? 0x331000 : 0)));

          // --- disparo ---
          if (aiming) {
            e.aimT -= dt;
            if (e.aimT <= 0) {
              e.cd = R(e.cdR[0], e.cdR[1]);
              const fx = Math.sin(e.g.rotation.y), fz = Math.cos(e.g.rotation.y);
              const a = new THREE.Vector3(e.g.position.x + fx * 0.5, 1.3 * e.sc, e.g.position.z + fz * 0.5);
              const b = new THREE.Vector3(hp0.x, hp0.y + 0.4, hp0.z);
              // precisión: mejor de cerca y contra un blanco quieto; cada tipo tiene la suya
              const pv = Math.hypot(heroBody.velocity.x, heroBody.velocity.z);
              const p = THREE.MathUtils.clamp(e.acc * (1 - 0.5 * d / e.range) * (pv > 2 ? 0.7 : 1) * (HIT_CHANCE / 0.45), 0.12, 0.85);
              const hit = Math.random() < p;
              if (!hit) {                                              // falla pasando cerca (no en una sola dirección)
                const ang = R(0, 6.28), rr = R(0.5, 1.7);
                b.x += Math.cos(ang) * rr; b.z += Math.sin(ang) * rr; b.y = R(0.1, 1.4);
                burst(b, 0xc9a173, 4);
              }
              tracer(a, b, e.tr); tone(200, 0.15, 'square', 0.12, 80);
              if (hit) hurt(Math.round((HIT_DMG[0] + Math.floor(Math.random() * (HIT_DMG[1] - HIT_DMG[0] + 1))) * e.dmg));
            }
          }
        }
        // botiquines: giran y se recogen al acercarse; al tomarlos desaparecen (y del minimapa) y
        // reaparecen unos segundos después en otro punto libre del escenario
        for (const p of picks) {
          if (!p.visible) {
            p.userData.wait -= dt;
            if (p.userData.wait <= 0) {
              placePick(p); p.visible = true; p.userData.born = t;
              burst(p.position.clone(), 0xffffff, 8); tone(700, 0.12, 'triangle', 0.12, 1100);
            }
            continue;
          }
          p.rotation.y += dt * 1.5; p.position.y = 0.6 + Math.sin(t * 2 + p.id) * 0.08;
          if (Math.hypot(p.position.x - hp0.x, p.position.z - hp0.z) < 1.5) {
            S.hp = Math.min(MAXHP, S.hp + PICK_HEAL); tone(500, 0.2, 'triangle', 0.25, 1000); haptic(0.4, 100);
            burst(p.position.clone(), 0xffffff, 10);
            p.visible = false; p.userData.wait = R(PICK_WAIT[0], PICK_WAIT[1]);
            S.msg = `+${PICK_HEAL} VIDA`; S.msgT = 1.6; S.msgC = '#8fe388';
          }
        }
      }
    }
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (enemies[i].state !== 'gone') continue;
      enemies[i].g.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
      scene.remove(enemies[i].g); enemies.splice(i, 1);
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]; p.life -= dt; p.v.y -= 9 * dt; p.m.position.addScaledVector(p.v, dt);
      if (p.life <= 0) { scene.remove(p.m); p.m.material.dispose(); parts.splice(i, 1); }
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      lines[i].life -= dt;
      if (lines[i].life <= 0) { scene.remove(lines[i].l); lines[i].l.geometry.dispose(); lines[i].l.material.dispose(); lines.splice(i, 1); }
    }
    healthP.mesh.visible = scoreP.mesh.visible = mmMesh.visible = running && !S.over;
    if (running && !S.over) drawMinimap();
    layoutHUD(inVR);
    drawHUD(S.msgT > 0 ? S.msg : '');
  }

  /* ---------- Entrada/salida de VR ---------- */
  renderer.xr.addEventListener('sessionstart', () => setTimeout(C.ensureRunning, 300));
  renderer.xr.addEventListener('sessionend', () => {
    rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0);
    hero.group.visible = true; wasVR = false;
    camera.position.copy(controls.target).add(new THREE.Vector3(0, 2, 3.2));
  });
  const b = VRButton.createButton(renderer);
  Object.assign(b.style, { bottom: 'auto', top: '14px', left: '18px', zIndex: 30 });
  document.getElementById('stage').appendChild(b);

  return { update, shootRay, dead: () => !!S.over };
}