import json, urllib.request, sys, time

body = {
    "text": (
        "通帳には、まとまったお金が残っている。それなのに、家の修理代を払おうとしたら、どのお金を動かせばいいのか分からない。\n"
        "解約すると損が出る。売るには時期が悪い。満期までは、まだ何年もある。こんな状態になったら、その残高を見て、本当に安心できるでしょうか。\n"
        "老後のお金で困るのは、使いすぎたときだけではありません。大切にしようとして動かしたお金が、必要なときに使いにくくなっている。そんな困り方もあるのです。\n"
        "退職金を守るために、最初に考えたいのは、何パーセントで増えるかではありません。自分が使いたいときに、どんな条件で使えるのか。その一点から、退職後のお金の見え方は変わります。"
    ),
    "ref_audio": r"C:\project\firm\flowkit\output\_shared\tts_templates\Minato_3353b67d.wav",
    "ref_text": "sample",
    "speed": 1.0,
}

data = json.dumps(body).encode("utf-8")
req = urllib.request.Request(
    "http://127.0.0.1:8100/api/tts/generate",
    data=data,
    headers={"Content-Type": "application/json"},
    method="POST",
)

text_len = len(body["text"])
print(f"Generating TTS for {text_len} chars of Japanese text with Minato voice...")
sys.stdout.flush()

start = time.time()
try:
    with urllib.request.urlopen(req, timeout=600) as resp:
        result = json.loads(resp.read().decode())
        elapsed = time.time() - start
        print(f"\nSUCCESS in {elapsed:.1f}s")
        print("Audio saved:", result.get("audio_path"))
        print("Duration ms:", result.get("duration_ms"))
except urllib.error.HTTPError as e:
    elapsed = time.time() - start
    print(f"\nHTTP {e.code} after {elapsed:.1f}s")
    print(e.read().decode())
except Exception as e:
    elapsed = time.time() - start
    print(f"\nERROR after {elapsed:.1f}s: {e}")
