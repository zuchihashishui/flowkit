"""Run TTS generation directly (bypass HTTP layer) to see the real error and get the output file."""
import sys, json, time, subprocess

from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from agent.config import TTS_MODEL, TTS_SAMPLE_RATE
from agent.services.tts import _TTS_SCRIPT, PYTHON_BIN

text = (
    "通帳には、まとまったお金が残っている。それなのに、家の修理代を払おうとしたら、どのお金を動かせばいいのか分からない。\n"
    "解約すると損が出る。売るには時期が悪い。満期までは、まだ何年もある。こんな状態になったら、その残高を見て、本当に安心できるでしょうか。\n"
    "老後のお金で困るのは、使いすぎたときだけではありません。大切にしようとして動かしたお金が、必要なときに使いにくくなっている。そんな困り方もあるのです。\n"
    "退職金を守るために、最初に考えたいのは、何パーセントで増えるかではありません。自分が使いたいときに、どんな条件で使えるのか。その一点から、退職後のお金の見え方は変わります。"
)

out_path = r"C:\project\firm\flowkit\output\_shared\minato_test_output.wav"

args = {
    "model": TTS_MODEL,
    "text": text,
    "output": out_path,
    "sample_rate": TTS_SAMPLE_RATE,
    "speed": 1.0,
    "ref_audio": r"C:\project\firm\flowkit\output\_shared\tts_templates\Minato_3353b67d.wav",
    "ref_text": "sample",
}

print(f"Text length: {len(text)} chars")
print("Running subprocess directly, streaming stderr live...")
sys.stdout.flush()

start = time.time()
proc = subprocess.Popen(
    [PYTHON_BIN, "-c", _TTS_SCRIPT, json.dumps(args)],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)

last_print = time.time()
while True:
    ret = proc.poll()
    if ret is not None:
        break
    time.sleep(2)
    if time.time() - last_print > 20:
        print(f"...still running at {time.time()-start:.0f}s")
        sys.stdout.flush()
        last_print = time.time()

stdout, stderr = proc.communicate()
elapsed = time.time() - start
print(f"\nDONE after {elapsed:.1f}s, returncode={proc.returncode}")
print("STDOUT:", stdout[-500:])
print("STDERR tail:", stderr[-1500:])
