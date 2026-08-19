Pod::Spec.new do |s|
  s.name           = 'LandlineKeyInput'
  s.version        = '1.0.0'
  s.summary        = 'Raw UIKeyInput key-event view for the landline terminal'
  s.description    = 'Delivers per-keystroke insertText/deleteBackward events without a text field.'
  s.author         = 'Tristan Colby'
  s.homepage       = 'https://github.com/tcolb/landline'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => 'https://github.com/tcolb/landline.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = "**/*.{h,m,mm,swift}"
end
