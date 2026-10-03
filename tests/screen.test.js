'use strict';
// Coverage for pure/DOM-light helpers in screen.js: section color lookup,
// time formatting, render HTML shape, click/wheel seek math.
// Runs under the org reusable CI as `node tests/screen.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function freshPlugin() {
    global.window = {};
    delete global.highway;
    global.document = { getElementById: () => null };
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    return require(file);
}

class FakeBar {
    constructor() {
        this.innerHTML = '';
        this.style = {};
        this._listeners = {};
        this.left = 0;
        this.width = 500;
    }
    addEventListener(type, fn) { this._listeners[type] = fn; }
    getBoundingClientRect() { return { left: this.left, width: this.width }; }
    querySelectorAll() { return []; }
}

class FakeAudio {
    constructor() {
        this.currentTime = 0;
        this.paused = true;
        this._listeners = {};
    }
    pause() { this.paused = true; }
    play() { this.paused = false; }
    addEventListener(type, fn) { this._listeners[type] = fn; }
    removeEventListener() {}
}

function timelineHarness(t, mod, sections = [], duration = 240, time = 60) {
    const bar = new FakeBar();
    const marker = { style: {} };
    const label = { textContent: '' };
    const song = { sections, duration, time };
    const seeks = [];
    let renders = 0;
    let html = '';
    Object.defineProperty(bar, 'innerHTML', {
        get: () => html,
        set: value => { html = value; renders++; },
    });
    global.highway = {
        getSections: () => song.sections,
        getSongInfo: () => ({ duration: song.duration }),
        getTime: () => song.time,
    };
    global.document = {
        getElementById: id => bar.innerHTML.includes(`id="${id}"`)
            ? ({ 'sm-marker': marker, 'sm-timeline-label': label }[id] || null) : null,
    };
    global.window.feedBack = { seek: (time, reason) => seeks.push([time, reason]) };
    mod._setState({ bar });
    t.after(() => { delete global.highway; });
    return { bar, marker, label, song, seeks, renders: () => renders };
}

for (const sections of [[], null, undefined]) {
    test(`a song with ${JSON.stringify(sections)} sections has progress and working seeks`, t => {
        const mod = freshPlugin();
        const view = timelineHarness(t, mod, sections);
        view.song.sections = sections;
        mod._smUpdate();

        assert.match(view.bar.innerHTML, /width:100%/);
        assert.equal(view.marker.style.left, '25%');
        assert.equal(view.label.textContent, 'Song timeline · 1:00 / 4:00');
        assert.equal((view.bar.innerHTML.match(/class="sm-block"/g) || []).length, 1);
        mod._smOnClick({ clientX: 250 });
        mod._smOnWheel({ deltaY: -1, ctrlKey: true, preventDefault() {} });
        assert.deepEqual(view.seeks, [[120, 'sectionmap-click'], [60.1, 'sectionmap-wheel']]);
        if (sections) assert.deepEqual(sections, [], 'the source sections stay untouched');

        view.song.time = 180;
        view.song.sections = []; // Hosts may return a fresh empty array each poll.
        mod._smUpdate();
        assert.equal(view.marker.style.left, '75%');
        assert.equal(view.label.textContent, 'Song timeline · 3:00 / 4:00');
        assert.equal(view.renders(), 1, 'updating progress must not recreate the bar');
    });
}

test('switching between labelled and unlabelled songs replaces the previous timeline', t => {
    const mod = freshPlugin();
    const authored = [{ name: 'Intro', time: 0 }, { name: 'Chorus', time: 60 }];
    const view = timelineHarness(t, mod, authored, 120);
    mod._smUpdate();
    assert.match(view.bar.innerHTML, />Chorus</);
    assert.doesNotMatch(view.bar.innerHTML, /sm-timeline-label/);

    view.song.sections = [];
    view.song.duration = 240;
    mod._smUpdate();
    assert.doesNotMatch(view.bar.innerHTML, />Chorus</);
    assert.equal(view.label.textContent, 'Song timeline · 1:00 / 4:00');

    view.song.sections = authored;
    mod._smUpdate();
    assert.match(view.bar.innerHTML, />Chorus</);
    assert.match(view.bar.innerHTML, /left:25%/);
    assert.doesNotMatch(view.bar.innerHTML, /sm-timeline-label/);
    assert.deepEqual(authored, [{ name: 'Intro', time: 0 }, { name: 'Chorus', time: 60 }]);
});

test('duration changes resize the same section array and update the seek range', t => {
    const mod = freshPlugin();
    const view = timelineHarness(t, mod, [{ name: 'Intro', time: 0 }, { name: 'Verse', time: 60 }], 120);
    mod._smUpdate();
    assert.match(view.bar.innerHTML, /left:50%/);
    view.song.duration = 240;
    mod._smUpdate();
    assert.match(view.bar.innerHTML, /left:25%/);
    mod._smOnClick({ clientX: 250 });
    assert.deepEqual(view.seeks, [[120, 'sectionmap-click']]);
});

test('unknown duration clears stale progress and disables seeks until timing arrives', t => {
    const mod = freshPlugin();
    const view = timelineHarness(t, mod);
    for (const duration of [0, undefined, null, NaN, Infinity, -1]) {
        view.song.duration = 240;
        mod._smUpdate();
        view.song.duration = duration;
        mod._smUpdate();
        assert.equal(view.bar.innerHTML, '');
        mod._smOnClick({ clientX: 250 });
        mod._smOnWheel({ deltaY: -1, preventDefault() {} });
        assert.deepEqual(view.seeks, []);
    }
    view.song.duration = 300;
    mod._smUpdate();
    assert.equal(view.label.textContent, 'Song timeline · 1:00 / 5:00');
    mod._smOnClick({ clientX: 250 });
    assert.deepEqual(view.seeks, [[150, 'sectionmap-click']]);
});

test('fallback progress stays inside the bar during preroll and at the end', t => {
    const mod = freshPlugin();
    const view = timelineHarness(t, mod);
    for (const [time, left, text] of [
        [-3, '0%', '0:00'], [250, '100%', '4:00'], [NaN, '0%', '0:00'],
    ]) {
        view.song.time = time;
        mod._smUpdate();
        assert.equal(view.marker.style.left, left);
        assert.equal(view.label.textContent, `Song timeline · ${text} / 4:00`);
    }
});

test('_smGetColor matches by substring, case-insensitively', () => {
    const mod = freshPlugin();
    assert.equal(mod._smGetColor('Verse 1'), '#22c55e');
    assert.equal(mod._smGetColor('CHORUS'), '#eab308');
    assert.equal(mod._smGetColor('Guitar Solo'), '#ef4444');
});

test('_smGetColor falls back to default for an unrecognized section name', () => {
    const mod = freshPlugin();
    assert.equal(mod._smGetColor('Mystery Section'), '#4b5563');
});

test('_smFmt formats seconds as m:ss with zero-padded seconds', () => {
    const mod = freshPlugin();
    assert.equal(mod._smFmt(0), '0:00');
    assert.equal(mod._smFmt(65), '1:05');
    assert.equal(mod._smFmt(600), '10:00');
});

test('_smRender builds one .sm-block-tagged div per section plus a position marker', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    mod._setState({
        bar,
        sections: [{ name: 'Intro', time: 0 }, { name: 'Verse 1', time: 10 }],
        duration: 20,
    });
    mod._smRender();
    assert.equal((bar.innerHTML.match(/sm-block/g) || []).length, 2);
    assert.ok(bar.innerHTML.includes('id="sm-marker"'));
    assert.ok(bar.innerHTML.includes('left:0%'));   // Intro starts at 0%
    assert.ok(bar.innerHTML.includes('left:50%'));  // Verse 1 starts at 10/20
});

test('_smRender strips a trailing numeric suffix and capitalizes the label', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    mod._setState({ bar, sections: [{ name: 'verse2', time: 0 }], duration: 10 });
    mod._smRender();
    assert.ok(bar.innerHTML.includes('>Verse<'));
});

// The seek must go through the host's canonical funnel (window.feedBack.seek),
// NOT raw audio.currentTime — the funnel is what repositions a native/streaming
// backend and emits song:seek so the stem worklet reseeks. Poking the <audio>
// element only moved regions buffered near the playhead (the far-section bug).

test('_smOnClick routes the clicked fraction through the host seek funnel', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    bar.width = 500;
    const seeks = [];
    global.window.feedBack = { seek: (t, reason) => seeks.push([t, reason]) };
    const audio = new FakeAudio();
    mod._setState({ bar, sections: [{ name: 'Intro', time: 0 }], duration: 100 });
    global.document = { getElementById: (id) => (id === 'audio' ? audio : null) };

    mod._smOnClick({ clientX: 250 }); // 50% across a 500px-wide bar
    assert.deepEqual(seeks, [[50, 'sectionmap-click']]);
    assert.equal(audio.currentTime, 0, 'must not poke the raw element when the funnel exists');
});

test('_smOnClick clamps a right-edge overshoot to the song duration', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    bar.width = 500;
    const seeks = [];
    global.window.feedBack = { seek: (t, reason) => seeks.push([t, reason]) };
    global.document = { getElementById: () => null };
    mod._setState({ bar, sections: [{ name: 'Intro', time: 0 }], duration: 100 });

    mod._smOnClick({ clientX: 505 }); // pct = 1.01 -> would be 101s without the clamp
    assert.deepEqual(seeks, [[100, 'sectionmap-click']]);
});

test('_smNow reads the host clock (getTime) so a wheel nudge starts from real position', () => {
    const mod = freshPlugin();
    global.highway = { getTime: () => 42 };
    const seeks = [];
    global.window.feedBack = { seek: (t, reason) => seeks.push([t, reason]) };
    global.document = { getElementById: () => null };
    mod._setState({ bar: new FakeBar(), sections: [{ name: 'Intro', time: 0 }], duration: 100 });
    try {
        mod._smOnWheel({ deltaY: -1, ctrlKey: true, preventDefault: () => {} });
        assert.deepEqual(seeks, [[42.1, 'sectionmap-wheel']]); // 42 (host clock) + 0.1 fine step
    } finally {
        delete global.highway;
    }
});

test('_smOnWheel routes the computed delta through the funnel and clamps to [0, duration]', () => {
    const mod = freshPlugin();
    const seeks = [];
    global.window.feedBack = { seek: (t, reason) => seeks.push([t, reason]) };
    const audio = new FakeAudio();
    audio.currentTime = 0; // no host clock in test -> falls back to audio position
    global.document = { getElementById: (id) => (id === 'audio' ? audio : null) };
    mod._setState({ bar: new FakeBar(), sections: [{ name: 'Intro', time: 0 }], duration: 100 });

    let prevented = false;
    mod._smOnWheel({ deltaY: 1, ctrlKey: false, preventDefault: () => { prevented = true; } }); // backward from 0
    assert.equal(prevented, true);
    assert.deepEqual(seeks, [[0, 'sectionmap-wheel']]); // clamped at 0, can't go negative
});

// Fallback: a host too old to expose window.feedBack.seek still seeks the raw
// <audio> element, pausing/resuming around it as before.

test('_smOnClick falls back to the raw <audio>, pausing/seeking/resuming while playing', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    const audio = new FakeAudio();
    audio.paused = false;
    mod._setState({ bar, sections: [{ name: 'Intro', time: 0 }], duration: 100 });
    global.document = { getElementById: (id) => (id === 'audio' ? audio : null) };

    mod._smOnClick({ clientX: 0 }); // no window.feedBack.seek -> fallback path
    assert.equal(audio.currentTime, 0);
    assert.equal(audio.paused, true); // paused before the seek
    audio._listeners.seeked(); // simulate the browser firing 'seeked'
    assert.equal(audio.paused, false); // resumed
});

test('_smOnWheel fallback pokes the raw <audio> when there is no seek API', () => {
    const mod = freshPlugin();
    const audio = new FakeAudio();
    audio.currentTime = 10;
    audio.paused = true;
    mod._setState({ bar: new FakeBar(), sections: [{ name: 'Intro', time: 0 }], duration: 100 });
    global.document = { getElementById: (id) => (id === 'audio' ? audio : null) };

    mod._smOnWheel({ deltaY: -1, ctrlKey: true, preventDefault: () => {} });
    assert.equal(audio.currentTime, 10.1); // scroll up -> forward by 0.1s (ctrl = fine)
});

test('_smOnWheel/_smOnClick are no-ops without a known duration', () => {
    const mod = freshPlugin();
    const audio = new FakeAudio();
    mod._setState({ bar: new FakeBar(), sections: [], duration: 0 });
    global.document = { getElementById: (id) => (id === 'audio' ? audio : null) };

    mod._smOnClick({ clientX: 100 });
    mod._smOnWheel({ deltaY: 1, preventDefault: () => {} });
    assert.equal(audio.currentTime, 0); // untouched
});
