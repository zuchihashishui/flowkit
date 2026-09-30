"""Direct TTS test to see actual error."""
import sys, json, torch
import soundfile as sf
import numpy as np
from pathlib import Path

text = """通帳には、まとまったお金が残っている。それなのに、家の修理代を払おうとしたら、どのお金を動かせばいいのか分からない。
解約すると損が出る。売るには時期が悪い。満期までは、まだ何年もある。こんな状態になったら、その残高を見て、本当に安心できるでしょうか。
老後のお金で困るのは、使いすぎたときだけではありません。大切にしようとして動かしたお金が、必要なときに使いにくくなっている。そんな困り方もあるのです。
退職金を守るために、最初に考えたいのは、何パーセントで増えるかではありません。自分が使いたいときに、どんな条件で使えるのか。その一点から、退職後のお金の見え方は変わります。"""

print(f"CUDA available: {torch.cuda.is_available()}")
print(f"Device: {'cuda' if torch.cuda.is_available() else 'cpu'}")

from omnivoice import OmniVoice

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.float16 if device == "cuda" else torch.float32

print(f"Loading OmniVoice model on {device}...")
model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map=device, dtype=dtype)

print("Generating audio...")
audio = model.generate(text=text, instruct="male, japanese accent", speed=1.0)

output_path = "output_shared/minato_retirement_money.wav"
Path(output_path).parent.mkdir(parents=True, exist_ok=True)

# Handle both numpy array and torch tensor
audio_data = audio[0] if isinstance(audio, (list, tuple)) else audio
if isinstance(audio_data, torch.Tensor):
    audio_np = audio_data.detach().cpu().numpy()
else:
    audio_np = audio_data

# soundfile expects (samples,) or (samples, channels) — squeeze any leading channel dim
audio_np = np.squeeze(audio_np)

print(f"Saving to {output_path}...")
sf.write(output_path, audio_np, 24000)
print(f"Done: {output_path}")
