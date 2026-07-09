import sys

from mlx_lm import generate, load
from mlx_lm.sample_utils import make_logits_processors, make_sampler


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: mlxGenerate.py <model_path> <prompt>", file=sys.stderr)
        return 2

    model_path = sys.argv[1]
    prompt = sys.argv[2]
    model, tokenizer = load(model_path)
    output = generate(
        model,
        tokenizer,
        prompt=render_chat_prompt(tokenizer, prompt),
        max_tokens=72,
        sampler=make_sampler(temp=0.0),
        logits_processors=make_logits_processors(repetition_penalty=1.12, repetition_context_size=80),
        verbose=False,
    )
    print(output.strip())
    return 0


def render_chat_prompt(tokenizer, prompt: str) -> str:
    apply_chat_template = getattr(tokenizer, "apply_chat_template", None)
    if not apply_chat_template:
        return prompt

    messages = [{"role": "user", "content": prompt}]
    try:
        return apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
    except TypeError:
        return apply_chat_template(messages, tokenize=False, add_generation_prompt=True)


if __name__ == "__main__":
    raise SystemExit(main())
