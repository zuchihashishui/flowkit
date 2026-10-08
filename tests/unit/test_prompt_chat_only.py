from agent.api.storyboard import PromptOptions, GenerateBody

def test_legacy_work_settings_and_new_requests_use_chat():
    assert PromptOptions(composer_mode='work').composer_mode == 'chat'
    assert GenerateBody(segment_ids=['s1'], composer_mode='work').composer_mode == 'chat'
    assert GenerateBody(segment_ids=['s1']).composer_mode == 'chat'
