/* =====================================================================
   ARMADILLO (Red Dead Redemption 1) – pueblo construido a partir del mapa.
   Escala del mapa: 0.035 m/px  ->  x=(px-1000)*S , z=(py-615)*S
   Norte = -z. Rotación Y: sur 0, norte π, oeste -π/2, este π/2.
   ===================================================================== */
import * as THREE from 'three';

export function buildTown({ scene, canvasTex, addStaticBox, CONFIG, buildCactus }) {
  const town = {
    buildings: [], props: [], roads: [], rails: [], blockers: [],
    inTown: (x, z, m = 0) => x > -36 - m && x < 35 + m && z > -22.5 - m && z < 21.5 + m,
  };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const PAL = {
    orange: ['#b8672e', '#a95a27'], grey: ['#8a7f72', '#7a7064'], brown: ['#5e3f27', '#4f3320'],
    pale: ['#c9a878', '#b99665'], roof: ['#4a3426', '#3c2a1e'], deck: ['#7a5a3a', '#6a4c30'],
    red: ['#8c3a26', '#7a301f'], stone: ['#9a9186', '#8a8176'],
  };
  const texC = {}, matC = {};
  function plank(kind) {
    if (texC[kind]) return texC[kind];
    const [c1, c2] = PAL[kind];
    return (texC[kind] = canvasTex(256, 256, (g, w, h) => {
      if (kind === 'stone') {
        g.fillStyle = c1; g.fillRect(0, 0, w, h);
        for (let y = 0; y < 8; y++) for (let x = 0; x < 5; x++) {
          g.fillStyle = Math.random() < .5 ? c1 : c2;
          g.fillRect(x * 52 + (y % 2) * 26, y * 32, 50, 30);
        }
        return;
      }
      const n = kind === 'roof' ? 8 : 12, ph = h / n;
      for (let i = 0; i < n; i++) {
        g.fillStyle = i % 2 ? c1 : c2; g.fillRect(0, i * ph, w, ph);
        g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, i * ph, w, 2);
        for (let k = 0; k < 40; k++) {
          g.fillStyle = `rgba(${Math.random() < .5 ? '0,0,0' : '255,230,190'},.05)`;
          g.fillRect(Math.random() * w, i * ph + Math.random() * ph, rnd(10, 60), 1);
        }
      }
    }));
  }
  function mat(kind, rx = 1, ry = 1, tint) {
    const k = kind + rx + '_' + ry + (tint || '');
    if (matC[k]) return matC[k];
    const t = plank(kind).clone(); t.needsUpdate = true; t.repeat.set(rx, ry);
    const m = new THREE.MeshStandardMaterial({ map: t, roughness: .95, metalness: 0 });
    if (tint) m.color.set(tint);
    return (matC[k] = m);
  }
  function signMat(text, aspect = 4, bg = '#e8dcc0', fg = '#2a1a10') {
    const h = 128, w = Math.round(h * aspect);
    const t = canvasTex(w, h, (g) => {
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.strokeStyle = fg; g.lineWidth = 6; g.strokeRect(6, 6, w - 12, h - 12);
      g.fillStyle = fg; g.font = `bold ${text.length > 9 ? 62 : 80}px Georgia, serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 + 4);
    });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return new THREE.MeshStandardMaterial({ map: t, roughness: .8 });
  }
  const winMat = new THREE.MeshStandardMaterial({ color: 0x15100c, roughness: .4 });
  const litMat = new THREE.MeshStandardMaterial({ color: 0xffc46a, emissive: 0xffa43a, emissiveIntensity: .9 });
  const frameMat = mat('brown', 1, 1);
  const bx = (w, h, d, m, x, y, z, p) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z); o.castShadow = o.receiveShadow = true; (p || scene).add(o); return o;
  };

  /* ---------- Edificio genérico (falso frente de madera, techo a dos aguas) ---------- */
  function house(o) {
    const { x, z, w, d, h, rot = 0, wall = 'orange', porch = 0, sign, windows = 2, roofRise = 1.1,
      upperWin = false, lit = true, stone = false, doorX = 0 } = o;
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; scene.add(g);
    const side = mat(wall, d / 2.2, h / 2.2), front = mat(wall, w / 2.2, h / 2.2), top = mat('roof', 2, 2);
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, top, top, front, front]);
    body.position.y = h / 2; body.castShadow = body.receiveShadow = true; g.add(body);
    // techo a dos aguas
    const sh = new THREE.Shape(); sh.moveTo(-d / 2 - .3, 0); sh.lineTo(0, roofRise); sh.lineTo(d / 2 + .3, 0); sh.closePath();
    const rg = new THREE.ExtrudeGeometry(sh, { depth: w + .5, bevelEnabled: false });
    rg.translate(0, 0, -(w + .5) / 2); rg.rotateY(Math.PI / 2);
    const roof = new THREE.Mesh(rg, mat('roof', 3, 3)); roof.position.y = h; roof.castShadow = true; g.add(roof);
    // falso frente + cornisa
    const ff = bx(w + .1, .9, .25, mat(wall, w / 2.2, .4), 0, h + .45, d / 2, g);
    bx(w + .4, .18, .45, frameMat, 0, h + .95, d / 2 + .05, g);
    // puerta y ventanas
    const fz = d / 2 + .02 + porch * 0;
    bx(1.05, 2.1, .1, frameMat, doorX, 1.05, fz + .03, g);
    const n = windows, gap = w / (n + 1);
    for (let i = 0; i < n; i++) {
      const wx = -w / 2 + gap * (i + 1) + (n === 1 ? 0 : 0);
      if (Math.abs(wx - doorX) < 1.3) continue;
      const m = lit && Math.random() < .5 ? litMat : winMat;
      bx(.95, 1.2, .1, frameMat, wx, 1.6, fz + .02, g);
      bx(.8, 1.05, .12, m, wx, 1.6, fz + .04, g);
      if (upperWin) { bx(.95, 1.2, .1, frameMat, wx, h - 1.4, fz + .02, g); bx(.8, 1.05, .12, Math.random() < .4 ? litMat : winMat, wx, h - 1.4, fz + .04, g); }
    }
    // porche
    if (porch > 0) {
      bx(w, .22, porch, mat('deck', w / 2, 1), 0, .11, d / 2 + porch / 2, g);
      for (const px of [-w / 2 + .15, w / 2 - .15]) {
        bx(.16, 2.8, .16, frameMat, px, 1.5, d / 2 + porch - .1, g);
        const lz = d / 2 + porch - .1, c = Math.cos(rot), sn = Math.sin(rot);
        addStaticBox(x + px * c + lz * sn, 1.5, z - px * sn + lz * c, .2, 1.5, .2, 0);
      }
      const pr = bx(w + .3, .12, porch + .5, mat('roof', 2, 1), 0, 2.95, d / 2 + porch / 2 + .1, g); pr.rotation.x = .1;
    }
    if (sign) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(w - .4, 3.6), .75), signMat(sign, 4.5));
      s.position.set(0, 3.4, d / 2 + porch + .02); if (porch === 0) s.position.y = h + .5; s.position.z = d / 2 + .3; g.add(s);
    }
    addStaticBox(x, h / 2, z, ...(Math.abs(Math.sin(rot)) > .5 ? [d / 2, h / 2, w / 2, 0] : [w / 2, h / 2, d / 2, 0]));
    const gg = g; town.buildings.push({ x, z, w, d, rot, porch, kind: wall, stone });
    body.userData.blocker = true; town.blockers.push(body);
    return gg;
  }

  /* ---------- SALOON (naranja, dos pisos, balcón, escalera a la izquierda) ---------- */
  function saloon() {
    const x = -12.5, z = -8.3, w = 11, d = 9.6, h = 7, pd = 2.3;
    const g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
    const side = mat('orange', 4, 3), front = mat('orange', 5, 3), top = mat('roof', 2, 2);
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, top, top, front, front]);
    body.position.y = h / 2; body.castShadow = body.receiveShadow = true; g.add(body);
    town.blockers.push(body);
    const sh = new THREE.Shape(); sh.moveTo(-d / 2 - .3, 0); sh.lineTo(0, 1.4); sh.lineTo(d / 2 + .3, 0); sh.closePath();
    const rg = new THREE.ExtrudeGeometry(sh, { depth: w + .6, bevelEnabled: false });
    rg.translate(0, 0, -(w + .6) / 2); rg.rotateY(Math.PI / 2);
    const roof = new THREE.Mesh(rg, mat('roof', 4, 3)); roof.position.y = h; roof.castShadow = true; g.add(roof);
    // frontón y cartel
    bx(w + .2, 1.1, .3, mat('orange', 5, .5), 0, h + .55, d / 2, g);
    bx(w + .5, .2, .55, frameMat, 0, h + 1.15, d / 2 + .05, g);
    const sg = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 1), signMat('SALOON', 4, '#e9dcbc', '#2a1a10'));
    sg.position.set(0, h + .55, d / 2 + .2); g.add(sg);
    // porche planta baja
    bx(w + .6, .25, pd, mat('deck', 5, 1), 0, .12, d / 2 + pd / 2, g);
    for (let i = 0; i < 5; i++) bx(.2, 3.6, .2, frameMat, -w / 2 + .1 + i * (w - .2) / 4, 1.95, d / 2 + pd - .1, g);
    // balcón (piso 2)
    bx(w + .6, .22, pd, mat('deck', 5, 1), 0, 3.7, d / 2 + pd / 2, g);
    bx(w + .6, .18, .2, frameMat, 0, 3.55, d / 2 + pd - .1, g);
    for (let i = 0; i < 5; i++) bx(.18, 2.7, .18, frameMat, -w / 2 + .1 + i * (w - .2) / 4, 5.05, d / 2 + pd - .1, g);
    bx(w + .6, .2, pd + .3, mat('roof', 5, 1), 0, 6.4, d / 2 + pd / 2, g).rotation.x = .08;
    // barandal con balaustres
    const bal = new THREE.InstancedMesh(new THREE.BoxGeometry(.07, .9, .07), frameMat, 34);
    const m4 = new THREE.Matrix4(); let c = 0;
    for (let i = 0; i < 24; i++, c++) { m4.makeTranslation(-w / 2 + .1 + i * (w - .2) / 23, 4.26, d / 2 + pd - .1); bal.setMatrixAt(c, m4); }
    for (let i = 0; i < 5; i++, c++) { m4.makeTranslation(-w / 2 + .1, 4.26, d / 2 + .2 + i * (pd - .3) / 4); bal.setMatrixAt(c, m4); }
    for (let i = 0; i < 5; i++, c++) { m4.makeTranslation(w / 2 - .1, 4.26, d / 2 + .2 + i * (pd - .3) / 4); bal.setMatrixAt(c, m4); }
    bal.count = c; g.add(bal);
    bx(w, .08, .1, frameMat, 0, 4.72, d / 2 + pd - .1, g);
    // puertas batientes y ventanas
    bx(.9, 1.4, .08, frameMat, -.5, 1.1, d / 2 + .06, g); bx(.9, 1.4, .08, frameMat, .5, 1.1, d / 2 + .06, g);
    for (const wx of [-4, -2.6, 2.6, 4]) { bx(1.1, 1.5, .1, frameMat, wx, 1.7, d / 2 + .03, g); bx(.95, 1.35, .12, litMat, wx, 1.7, d / 2 + .05, g); }
    for (const wx of [-4, -2, 0, 2, 4]) { bx(1.1, 1.5, .1, frameMat, wx, 5.2, d / 2 + .03, g); bx(.95, 1.35, .12, wx === 0 ? winMat : litMat, wx, 5.2, d / 2 + .05, g); }
    // escalera lateral izquierda hacia el balcón
    for (let i = 0; i < 12; i++) bx(1.1, .14, .45, mat('deck', 1, 1), -w / 2 - .9, .3 + i * .3, d / 2 + pd - .6 - i * .17, g);
    bx(.1, 4.2, .1, frameMat, -w / 2 - 1.5, 2, d / 2 + pd - .6, g);
    // colisiones: postes del porche, escalera y barra de amarre
    for (let i = 0; i < 5; i++) addStaticBox(x - w / 2 + .1 + i * (w - .2) / 4, 1.9, z + d / 2 + pd - .1, .22, 1.9, .22, 0);
    addStaticBox(x - w / 2 - .9, .9, z + d / 2 + pd - 2.1, .6, .9, 1.9, 0);
    addStaticBox(x, .5, z + d / 2 + pd + 1.2, 2.6, .5, .12, 0);
    // barra de amarre
    bx(5, .1, .1, frameMat, 0, 1, d / 2 + pd + 1.2, g);
    for (const px of [-2.3, 2.3]) bx(.12, 1, .12, frameMat, px, .5, d / 2 + pd + 1.2, g);
    addStaticBox(x, h / 2, z, w / 2, h / 2, d / 2, 0);
    town.buildings.push({ x, z, w, d, rot: 0, porch: pd, kind: 'orange', big: true });
  }

  /* ---------- Establo / corral norte (tres paredes) ---------- */
  function stable() {
    const x = -15.5, z = -17.9, w = 7.5, d = 5;
    bx(w, 3.2, .3, mat('brown', 3, 1.5), x, 1.6, z - d / 2);
    bx(.3, 3.2, d, mat('brown', 2, 1.5), x - w / 2, 1.6, z);
    bx(.3, 3.2, d, mat('brown', 2, 1.5), x + w / 2, 1.6, z);
    const r = bx(w + .8, .2, d + .8, mat('roof', 3, 2), x, 3.35, z); r.rotation.x = -.08;
    addStaticBox(x, 1.6, z - d / 2, w / 2, 1.6, .15, 0);
    addStaticBox(x - w / 2, 1.6, z, .15, 1.6, d / 2, 0);
    addStaticBox(x + w / 2, 1.6, z, .15, 1.6, d / 2, 0);
    town.props.push({ t: 'box', x, z, w, d });
    // abrevadero
    bx(2.4, .6, .7, mat('brown', 1, 1), x, .3, z + 1.2); addStaticBox(x, .3, z + 1.2, 1.2, .5, .4, 0);
    // valla del corral
    fence(x - 5, z + d / 2 + 1.5, x + 5, z + d / 2 + 1.5, true);
  }

  /* ---------- valla de madera ---------- */
  function fence(x1, z1, x2, z2, collide = true) {
    const len = Math.hypot(x2 - x1, z2 - z1), ang = Math.atan2(x2 - x1, z2 - z1);
    const n = Math.max(2, Math.round(len / 1.8));
    for (let i = 0; i <= n; i++) bx(.14, 1.3, .14, frameMat, x1 + (x2 - x1) * i / n, .65, z1 + (z2 - z1) * i / n);
    for (const y of [.5, 1.05]) {
      const r = bx(.08, .1, len, frameMat, (x1 + x2) / 2, y, (z1 + z2) / 2); r.rotation.y = ang;
    }
    if (collide) addStaticBox((x1 + x2) / 2, .65, (z1 + z2) / 2, .08, .65, len / 2, ang);
    town.props.push({ t: 'fence', x1, z1, x2, z2 });
  }

  /* ---------- Estación de tren + torre de agua + vía ---------- */
  function station() {
    // plataforma
    bx(6.85, .35, 14, mat('deck', 3, 6), -26.3, .17, -1.6);
    // edificio de la estación (mira al este -> rot -π/2)
    house({ x: -25.9, z: -2.8, w: 5.2, d: 3.4, h: 3.8, rot: -Math.PI / 2, wall: 'pale', porch: 1.2, sign: 'ARMADILLO', windows: 2, roofRise: .9 });
    // techo de andén
    const r = bx(3.2, .15, 13, mat('roof', 2, 4), -28.4, 3.4, -1.6);
    for (const pz of [-7, -2.5, 2, 6]) { bx(.2, 3.3, .2, frameMat, -27.0, 1.7, pz); addStaticBox(-27.0, 1.7, pz, .25, 1.7, .25, 0); }
    town.props.push({ t: 'station' });
  }
  function waterTower(x, z) {
    const wood = mat('brown', 2, 2);
    for (const [dx, dz] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]]) bx(.28, 6.2, .28, wood, x + dx, 3.1, z + dz);
    bx(2.6, .25, 2.6, wood, x, 5.6, z);
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 2.8, 20), new THREE.MeshStandardMaterial({ color: 0x3f6f9a, roughness: .6, metalness: .2 }));
    tank.position.set(x, 7.1, z); tank.castShadow = true; scene.add(tank);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.8, 1, 20), mat('roof', 2, 1)); cone.position.set(x, 8.9, z); scene.add(cone);
    addStaticBox(x, 3, z, 1.3, 3, 1.3, 0);
    town.props.push({ t: 'tower', x, z });
  }
  function rails() {
    const rx = -31.85, z0 = -40, z1 = 40;
    bx(1.9, .12, 80, new THREE.MeshStandardMaterial({ color: 0x6f665a, roughness: 1 }), rx, .06, 0);
    for (const dx of [-.72, .72]) bx(.1, .14, 80, new THREE.MeshStandardMaterial({ color: 0x4a4a4f, metalness: .7, roughness: .4 }), rx + dx, .2, 0);
    const sl = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, .1, .22), frameMat, 100), m4 = new THREE.Matrix4();
    for (let i = 0; i < 100; i++) { m4.makeTranslation(rx, .15, z0 + i * .8); sl.setMatrixAt(i, m4); }
    scene.add(sl);
    town.rails.push({ x: rx, z0, z1 });
  }

  /* ---------- carretas, postes, letrina, plataforma en ruinas ---------- */
  function cart(x, z, rot) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; scene.add(g);
    bx(1.6, .25, 3, mat('brown', 1, 2), 0, .85, 0, g);
    for (const s of [-1, 1]) {
      bx(.08, .5, 3, mat('brown', 1, 2), s * .8, 1.2, 0, g);
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(.55, .55, .1, 14), mat('brown', 1, 1)); wh.rotation.z = Math.PI / 2;
      wh.position.set(s * .9, .55, .3); wh.castShadow = true; g.add(wh);
    }
    bx(.1, .1, 2, frameMat, 0, .6, 2.2, g);
    addStaticBox(x, .7, z, Math.abs(Math.cos(rot)) * .9 + Math.abs(Math.sin(rot)) * 1.6, .7, Math.abs(Math.cos(rot)) * 1.6 + Math.abs(Math.sin(rot)) * .9, 0);
    town.props.push({ t: 'cart', x, z, rot });
  }
  function poles() {
    const wire = new THREE.LineBasicMaterial({ color: 0x1a1410 });
    const xs = [-24, -10, 4, 18];
    xs.forEach((px, i) => {
      bx(.22, 7.5, .22, frameMat, px, 3.75, 3.2); bx(1.6, .15, .15, frameMat, px, 7, 3.2);
      addStaticBox(px, 3, 3.2, .15, 3, .15, 0);
      if (i < xs.length - 1) for (const o of [-.7, .7]) {
        const pts = []; for (let k = 0; k <= 10; k++) { const t = k / 10; pts.push(new THREE.Vector3(px + (xs[i + 1] - px) * t + o * 0, 7 - Math.sin(t * Math.PI) * .7, 3.2 + o * .0 + o * .1)); }
        scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wire));
      }
    });
  }
  function outhouse(x, z) {
    bx(1.4, 2.4, 1.4, mat('brown', 1, 1), x, 1.2, z); bx(1.7, .15, 1.7, mat('roof', 1, 1), x, 2.5, z);
    addStaticBox(x, 1.2, z, .7, 1.2, .7, 0); town.props.push({ t: 'box', x, z, w: 1.4, d: 1.4 });
  }
  function ruin(x, z) {
    bx(7, .25, 5, mat('deck', 3, 2), x, .15, z).rotation.z = .04;
    for (const [dx, dz, hh] of [[-3, -2, 2.4], [3, -2, 1.5], [-3, 2, 3], [0, -2.2, 1.2]]) { bx(.22, hh, .22, frameMat, x + dx, hh / 2, z + dz); addStaticBox(x + dx, hh / 2, z + dz, .2, hh / 2, .2, 0); }
    bx(6, .15, .15, frameMat, x, 2.3, z - 2).rotation.z = -.18;
    addStaticBox(x - 3, 1.2, z - 2, .15, 1.2, .15, 0); addStaticBox(x - 3, 1.5, z + 2, .15, 1.5, .15, 0);
    town.props.push({ t: 'ruin', x, z });
  }

  /* ---------- caminos de tierra (decal sobre el suelo) ---------- */
  const ROADS = [
    { w: 8, p: [[-24, 1.9], [-8, 1.9], [10, 1.9], [21, 1.9]] },        // calle principal
    { w: 5, p: [[-31, 1.9], [-24, 1.9]] },                              // acceso a la estación
    { w: 4, p: [[-21, 1.9], [-21.5, 10], [-20, 18.5]] },                // vertical izquierda
    { w: 4, p: [[18.5, 1.9], [18.8, -8], [18, -16]] },                  // vertical derecha (norte)
    { w: 4, p: [[18.5, 1.9], [18.8, 10], [17, 19]] },                   // vertical derecha (sur)
    { w: 4, p: [[-21, 1.9], [-21, -6], [-18, -14], [-4, -14.5], [10, -14], [18, -16]] },
    { w: 4, p: [[-20, 18.5], [-8, 19.5], [6, 19.2], [17, 19]] },
  ];
  town.roads = ROADS;
  function roadDecal() {
    const N = 1024, k = N / 80;
    const tex = canvasTex(N, N, (g) => {
      g.clearRect(0, 0, N, N); g.lineCap = g.lineJoin = 'round';
      for (const r of ROADS) {
        const trace = () => { g.beginPath(); r.p.forEach(([x, z], i) => g[i ? 'lineTo' : 'moveTo']((x + 40) * k, (z + 40) * k)); };
        g.strokeStyle = 'rgba(120,92,58,.55)'; g.lineWidth = (r.w + 1.6) * k; trace(); g.stroke();
        g.strokeStyle = '#a98a5c'; g.lineWidth = r.w * k; trace(); g.stroke();
      }
      for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(${Math.random() < .5 ? '60,40,20' : '230,200,150'},.07)`; g.fillRect(Math.random() * N, Math.random() * N, 3, 2); }
      g.globalCompositeOperation = 'destination-in';   // recorta el ruido a los caminos
      for (const r of ROADS) { g.beginPath(); r.p.forEach(([x, z], i) => g[i ? 'lineTo' : 'moveTo']((x + 40) * k, (z + 40) * k)); g.lineWidth = (r.w + 1.6) * k; g.stroke(); }
    });
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({
      map: tex, transparent: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.y = .02; m.receiveShadow = true; scene.add(m);
  }

  /* ---------- vegetación del desierto ---------- */
  function desert() {
    const out = (x, z) => !town.inTown(x, z, 2) && Math.abs(x + 31.85) > 3 && Math.abs(x) < 38.5 && Math.abs(z) < 38.5;
    const scrub = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(.45, 0), new THREE.MeshStandardMaterial({ color: 0x6f6a3a, roughness: 1, flatShading: true }), 90);
    const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(.4, 0), new THREE.MeshStandardMaterial({ color: 0x8a7a68, roughness: 1, flatShading: true }), 40);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
    for (const [im, n, y] of [[scrub, 90, .22], [rocks, 40, .15]]) {
      for (let i = 0; i < n; i++) {
        let x, z, t = 0; do { x = rnd(-38, 38); z = rnd(-38, 38); } while (!out(x, z) && ++t < 40);
        const k = rnd(.6, 1.5); e.set(rnd(0, 3), rnd(0, 6), rnd(0, 3)); q.setFromEuler(e);
        m4.compose(p.set(x, y * k, z), q, s.set(k, k * .7, k)); im.setMatrixAt(i, m4);
      }
      im.castShadow = true; scene.add(im);
    }
    [[-36, 15, 1], [-34, -22, 1.1], [30, -26, 1], [33, 24, .9], [0, 32, 1], [-10, 35, 1.1], [16, 33, 1], [36, -8, 1.2],
     [-20, -32, 1], [8, -33, .9], [28, -33, 1], [-35, 31, 1.1], [34, 6, 1], [-6, 28, .9]].forEach(([x, z, k]) => buildCactus(x, z, k));
  }

  /* ---------- CONSTRUCCIÓN ---------- */
  roadDecal();
  rails(); station(); waterTower(-28.2, 3.85); poles();
  saloon(); stable();
  // fila norte (miran al sur)
  const N = { rot: 0, porch: 1.05, d: 6.65, z: -6.475 };
  house({ ...N, x: -2.1, w: 5.6, h: 4.0, wall: 'pale', sign: 'GENERAL STORE', windows: 2 });
  house({ ...N, x: 2.75, w: 3.5, h: 4.2, wall: 'orange', sign: 'BARBER', windows: 1, doorX: 0.7 });
  house({ ...N, x: 6.55, w: 3.3, h: 3.8, wall: 'brown', sign: 'DOCTOR', windows: 1, doorX: -.6 });
  house({ ...N, x: 12.5, w: 6.5, h: 4.4, wall: 'grey', sign: 'UNDERTAKER', windows: 2 });
  house({ x: 14.05, z: -10.95, w: 3.4, d: 2.3, h: 3, wall: 'brown', windows: 0 });
  // casas del este (miran al oeste)
  const E = { rot: -Math.PI / 2, d: 4.8 };
  house({ ...E, x: 24.1, z: -3.7, w: 5.7, d: 5.0, h: 3.8, wall: 'orange', porch: .7, windows: 2 });
  house({ ...E, x: 25.2, z: 1.65, w: 3.3, h: 3.4, wall: 'pale', porch: .7, windows: 1, doorX: .5 });
  house({ ...E, x: 25.2, z: 6.45, w: 4.3, h: 3.6, wall: 'brown', porch: .7, windows: 1, doorX: -.6 });
  // fila sur (miran al norte)
  const Sx = { rot: Math.PI, porch: 1.05 };
  house({ ...Sx, x: -14.5, z: 12.1, w: 6.65, d: 10.4, h: 5.2, wall: 'pale', sign: 'HOTEL', windows: 2, upperWin: true, roofRise: 1.3 });
  house({ ...Sx, x: -6.45, z: 10.75, w: 7.7, d: 8.3, h: 4.0, wall: 'orange', sign: 'GUNSMITH', windows: 2 });
  house({ ...Sx, x: 3.15, z: 11.9, w: 7.3, d: 10.6, h: 4.2, wall: 'stone', stone: true, sign: 'SHERIFF', windows: 2, lit: false });
  house({ ...Sx, x: 10.85, z: 10.4, w: 5.6, d: 7.6, h: 3.8, wall: 'brown', sign: 'TELEGRAPH', windows: 2 });
  // carretas, corral, letrina, ruinas
  cart(-2.1, -14.2, .3); cart(-26.8, 9.1, 1.2); cart(29.1, 8.9, -.5);
  fence(-29.5, 12, -29.5, 20); fence(-29.5, 20, -23.5, 20); fence(-23.5, 12, -23.5, 17);
  outhouse(-8.2, -15.6); ruin(27.5, 15.4);
  desert();
  return town;
}