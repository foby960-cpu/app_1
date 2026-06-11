import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/app_provider.dart';
import '../l10n/app_localizations.dart';
import '../services/api_service.dart';
import 'login_screen.dart';
import 'main_shell.dart';

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});
  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _formKey = GlobalKey<FormState>();
  final _fullNameCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _licenseCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _confirmCtrl = TextEditingController();
  final _otpCtrl = TextEditingController();

  bool _loading = false;
  bool _obscurePass = true;
  bool _obscureConfirm = true;
  bool _otpSent = false;
  bool _otpVerified = false;
  bool _otpLoading = false;
  String _otpTarget = '';
  String _otpChannel = 'phone';
  String _autoFillOtp = '';
  String _verificationError = '';

  @override
  void dispose() {
    for (final c in [
      _fullNameCtrl,
      _emailCtrl,
      _phoneCtrl,
      _licenseCtrl,
      _passwordCtrl,
      _confirmCtrl,
      _otpCtrl
    ]) c.dispose();
    super.dispose();
  }

  Future<void> _sendOtp() async {
    String? phone;
    String? email;
    if (_otpChannel == 'phone') {
      phone = _phoneCtrl.text.trim();
      if (phone.isEmpty) {
        _snack('Enter phone number', Colors.orange);
        return;
      }
      _otpTarget = phone;
    } else {
      email = _emailCtrl.text.trim();
      if (email.isEmpty || !email.contains('@')) {
        _snack('Enter valid email', Colors.orange);
        return;
      }
      _otpTarget = email;
    }
    setState(() {
      _otpLoading = true;
      _otpSent = false;
      _otpVerified = false;
      _autoFillOtp = '';
      _verificationError = '';
      _otpCtrl.clear();
    });
    final response = await ApiService.sendOtp(
      phone: phone,
      email: email,
      name: _fullNameCtrl.text.trim().isEmpty
          ? 'User'
          : _fullNameCtrl.text.trim(),
    );
    if (!mounted) return;
    if (response['success'] == true) {
      if (response['otp'] != null && response['otp'].toString().isNotEmpty) {
        _autoFillOtp = response['otp'].toString();
        _otpCtrl.text = _autoFillOtp;
        _snack('OTP received – review and submit', Colors.blue);
      } else {
        _snack('OTP sent to $_otpTarget', Colors.green);
      }
      setState(() {
        _otpSent = true;
        _otpLoading = false;
      });
    } else {
      setState(() => _otpLoading = false);
      _snack('Failed: ${response['message']}', Colors.red);
    }
  }

  Future<void> _verifyOtp() async {
    final entered = _otpCtrl.text.trim();
    if (entered.isEmpty || entered.length != 6) {
      setState(() => _verificationError = 'Please enter 6-digit OTP');
      return;
    }
    setState(() {
      _otpLoading = true;
      _verificationError = '';
    });
    final response = await ApiService.verifyOtp(
      phone: _phoneCtrl.text.trim(),
      email: _emailCtrl.text.trim(),
      otp: entered,
    );
    if (!mounted) return;
    if (response['success'] == true && response['verified'] == true) {
      setState(() {
        _otpVerified = true;
        _otpLoading = false;
      });
      _snack('OTP Verified Successfully!', Colors.green);
      await _register();
    } else {
      setState(() {
        _otpLoading = false;
        _verificationError =
            response['message'] ?? 'Invalid OTP. Please try again.';
      });
      _snack(_verificationError, Colors.red);
    }
  }

  Future<void> _register() async {
    if (!_formKey.currentState!.validate()) return;
    if (!_otpVerified) {
      setState(() => _verificationError = 'Please verify your OTP first');
      return;
    }
    setState(() => _loading = true);
    final username = _emailCtrl.text.split('@').first.trim();
    final res = await ApiService.register(
      fullName: _fullNameCtrl.text.trim(),
      username: username,
      phone: _phoneCtrl.text.trim(),
      email: _emailCtrl.text.trim(),
      driverLicense:
          _licenseCtrl.text.trim().isEmpty ? null : _licenseCtrl.text.trim(),
      password: _passwordCtrl.text,
    );
    if (!mounted) return;
    setState(() => _loading = false);
    if (res.success) {
      _snack('Registration successful! Welcome to EcoWaste! 🌿', Colors.green);
      await Future.delayed(const Duration(milliseconds: 800));
      if (!mounted) return;
      final name = res.data?['user']?['full_name'] ?? username;
      Navigator.pushReplacement(context,
          MaterialPageRoute(builder: (_) => MainShell(username: name)));
    } else {
      _snack(res.message, Colors.red);
    }
  }

  void _snack(String msg, Color color) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(msg),
        backgroundColor: color,
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 3),
      ));

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppProvider>();
    final isDark = app.isDark;
    final isSw = app.isSwahili;
    final l10n = AppLocalizations.of(context);

    final bg = isDark ? const Color(0xFF0D1117) : const Color(0xFFF7F8FA);
    final cardBg = isDark ? const Color(0xFF161B22) : Colors.white;
    final cardBorder = isDark ? Colors.white10 : Colors.grey.shade200;
    final textPrimary = isDark ? Colors.white : const Color(0xFF1A1A1A);
    final textSecond = isDark ? Colors.white54 : Colors.black45;
    final inputFill = isDark ? const Color(0xFF0D1117) : Colors.white;
    final inputBorder = isDark ? Colors.white12 : Colors.grey.shade300;

    return Scaffold(
      backgroundColor: bg,
      appBar: AppBar(
        backgroundColor: isDark ? const Color(0xFF161B22) : Colors.white,
        foregroundColor: textPrimary,
        elevation: 0,
        title: Text(isSw ? 'Jisajili' : 'Create Account',
            style: const TextStyle(fontWeight: FontWeight.bold)),
        actions: [
          GestureDetector(
            onTap: () => app.setLocale(app.isSwahili ? 'en' : 'sw'),
            child: Container(
              margin: const EdgeInsets.only(right: 4, top: 10, bottom: 10),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: const Color(0xFF2E7D32).withOpacity(0.12),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(isSw ? '🇹🇿 SW' : '🇬🇧 EN',
                  style: const TextStyle(
                      color: Color(0xFF2E7D32),
                      fontSize: 12,
                      fontWeight: FontWeight.bold)),
            ),
          ),
          IconButton(
            icon: Icon(
                isDark ? Icons.light_mode_outlined : Icons.dark_mode_outlined,
                color: textPrimary),
            onPressed: app.toggleTheme,
          ),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
          child: Form(
            key: _formKey,
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 8),
                  Center(
                      child: Container(
                    width: 72,
                    height: 72,
                    decoration: BoxDecoration(
                      color: const Color(0xFF2E7D32),
                      shape: BoxShape.circle,
                      boxShadow: [
                        BoxShadow(
                            color: const Color(0xFF2E7D32).withOpacity(0.3),
                            blurRadius: 16,
                            offset: const Offset(0, 6))
                      ],
                    ),
                    child: const Icon(Icons.eco_rounded,
                        size: 40, color: Colors.white),
                  )),
                  const SizedBox(height: 14),
                  Text(isSw ? 'Jisajili' : 'Create Account',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                          color: textPrimary,
                          fontSize: 24,
                          fontWeight: FontWeight.bold)),
                  const SizedBox(height: 4),
                  Text(
                      isSw
                          ? 'Jiunge na jamii ya EcoWaste'
                          : 'Join the EcoWaste community',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: textSecond, fontSize: 14)),
                  const SizedBox(height: 28),
                  _field(
                      ctrl: _fullNameCtrl,
                      label: l10n.fullName,
                      icon: Icons.person_outline_rounded,
                      fill: inputFill,
                      border: inputBorder,
                      text: textPrimary,
                      validator: (v) => (v == null || v.trim().length < 2)
                          ? (isSw ? 'Ingiza jina kamili' : 'Enter full name')
                          : null),
                  const SizedBox(height: 14),
                  _field(
                      ctrl: _emailCtrl,
                      label: l10n.email,
                      icon: Icons.mail_outline_rounded,
                      type: TextInputType.emailAddress,
                      fill: inputFill,
                      border: inputBorder,
                      text: textPrimary,
                      validator: (v) => (v == null || !v.contains('@'))
                          ? (isSw ? 'Barua pepe sahihi' : 'Enter valid email')
                          : null),
                  const SizedBox(height: 14),
                  _field(
                      ctrl: _phoneCtrl,
                      label: l10n.phone,
                      icon: Icons.phone_outlined,
                      hint: '+255...',
                      type: TextInputType.phone,
                      fill: inputFill,
                      border: inputBorder,
                      text: textPrimary),
                  const SizedBox(height: 14),
                  _field(
                      ctrl: _licenseCtrl,
                      label: isSw
                          ? '${l10n.driverLicense} (hiari)'
                          : '${l10n.driverLicense} (optional)',
                      icon: Icons.badge_outlined,
                      fill: inputFill,
                      border: inputBorder,
                      text: textPrimary),
                  const SizedBox(height: 14),
                  _passField(
                      ctrl: _passwordCtrl,
                      label: l10n.password,
                      obscure: _obscurePass,
                      onToggle: () =>
                          setState(() => _obscurePass = !_obscurePass),
                      fill: inputFill,
                      border: inputBorder,
                      text: textPrimary,
                      validator: (v) => (v == null || v.length < 6)
                          ? (isSw
                              ? 'Angalau herufi 6'
                              : 'At least 6 characters')
                          : null),
                  const SizedBox(height: 14),
                  _passField(
                      ctrl: _confirmCtrl,
                      label: isSw ? 'Thibitisha Nenosiri' : 'Confirm Password',
                      obscure: _obscureConfirm,
                      onToggle: () =>
                          setState(() => _obscureConfirm = !_obscureConfirm),
                      fill: inputFill,
                      border: inputBorder,
                      text: textPrimary,
                      validator: (v) => v != _passwordCtrl.text
                          ? (isSw
                              ? 'Manenosiri hayafanani'
                              : 'Passwords do not match')
                          : null),
                  const SizedBox(height: 22),
                  _buildOtpCard(cardBg, cardBorder, textPrimary, textSecond,
                      isDark, isSw),
                  const SizedBox(height: 26),
                  SizedBox(
                    height: 52,
                    child: ElevatedButton(
                      onPressed: (_loading || !_otpVerified) ? null : _register,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF2E7D32),
                        foregroundColor: Colors.white,
                        disabledBackgroundColor:
                            const Color(0xFF2E7D32).withOpacity(0.4),
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(14)),
                      ),
                      child: _loading
                          ? const SizedBox(
                              height: 22,
                              width: 22,
                              child: CircularProgressIndicator(
                                  strokeWidth: 2, color: Colors.white))
                          : Text(isSw ? 'Jisajili' : 'Register',
                              style: const TextStyle(
                                  fontSize: 16, fontWeight: FontWeight.bold)),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                    Text(
                        isSw
                            ? 'Tayari una akaunti?'
                            : 'Already have an account?',
                        style: TextStyle(color: textSecond)),
                    TextButton(
                      onPressed: () => Navigator.pushReplacement(
                          context,
                          MaterialPageRoute(
                              builder: (_) => const LoginScreen())),
                      child: Text(l10n.login,
                          style: const TextStyle(
                              color: Color(0xFF2E7D32),
                              fontWeight: FontWeight.bold)),
                    ),
                  ]),
                  const SizedBox(height: 12),
                ]),
          ),
        ),
      ),
    );
  }

  Widget _buildOtpCard(Color cardBg, Color cardBorder, Color textPrimary,
      Color textSecond, bool isDark, bool isSw) {
    final otpBorder = isDark ? Colors.white12 : Colors.grey.shade300;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: cardBg,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: _otpVerified
              ? const Color(0xFF2E7D32).withOpacity(0.5)
              : cardBorder,
          width: _otpVerified ? 1.5 : 1,
        ),
        boxShadow: [
          BoxShadow(
              color: Colors.black.withOpacity(isDark ? 0.2 : 0.04),
              blurRadius: 10,
              offset: const Offset(0, 3))
        ],
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Container(
            padding: const EdgeInsets.all(7),
            decoration: BoxDecoration(
              color: _otpVerified
                  ? const Color(0xFF2E7D32).withOpacity(0.12)
                  : Colors.orange.withOpacity(0.12),
              shape: BoxShape.circle,
            ),
            child: Icon(
              _otpVerified ? Icons.verified_rounded : Icons.security_rounded,
              size: 18,
              color: _otpVerified ? const Color(0xFF2E7D32) : Colors.orange,
            ),
          ),
          const SizedBox(width: 10),
          Text(
            _otpVerified
                ? (isSw ? '✓ Imethibitishwa' : '✓ Verified')
                : (isSw ? 'Thibitisha Mawasiliano' : 'Verify Your Contact'),
            style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 15,
                color: _otpVerified
                    ? const Color(0xFF2E7D32)
                    : Colors.orange.shade800),
          ),
          if (_otpVerified) ...[
            const Spacer(),
            const Icon(Icons.check_circle_rounded,
                color: Color(0xFF2E7D32), size: 20),
          ],
        ]),
        if (!_otpVerified) ...[
          const SizedBox(height: 16),
          Row(children: [
            Expanded(
                child: _channelBtn(
                    isSw ? 'SMS' : 'SMS',
                    Icons.sms_rounded,
                    _otpChannel == 'phone',
                    isDark,
                    () => setState(() {
                          _otpChannel = 'phone';
                          _otpSent = false;
                          _autoFillOtp = '';
                          _verificationError = '';
                          _otpCtrl.clear();
                        }))),
            const SizedBox(width: 10),
            Expanded(
                child: _channelBtn(
                    isSw ? 'Barua Pepe' : 'Email',
                    Icons.mail_rounded,
                    _otpChannel == 'email',
                    isDark,
                    () => setState(() {
                          _otpChannel = 'email';
                          _otpSent = false;
                          _autoFillOtp = '';
                          _verificationError = '';
                          _otpCtrl.clear();
                        }))),
          ]),
          const SizedBox(height: 16),
          if (!_otpSent)
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                onPressed: _otpLoading ? null : _sendOtp,
                icon: _otpLoading
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Colors.white))
                    : Icon(
                        _otpChannel == 'phone'
                            ? Icons.send_to_mobile_rounded
                            : Icons.forward_to_inbox_rounded,
                        size: 18),
                label: Text(
                    _otpLoading
                        ? (isSw ? 'Inatuma...' : 'Sending…')
                        : (isSw
                            ? 'Tuma OTP kwa ${_otpChannel == 'phone' ? 'SMS' : 'Barua Pepe'}'
                            : 'Send OTP via ${_otpChannel == 'phone' ? 'SMS' : 'Email'}'),
                    style: const TextStyle(fontWeight: FontWeight.w600)),
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF1976D2),
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 13),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12)),
                ),
              ),
            ),
          if (_otpSent) ...[
            if (_autoFillOtp.isNotEmpty) ...[
              const SizedBox(height: 4),
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: Colors.amber.withOpacity(isDark ? 0.12 : 0.07),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: Colors.amber.shade400),
                ),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(children: [
                        Icon(Icons.info_outline_rounded,
                            color: Colors.amber.shade700, size: 16),
                        const SizedBox(width: 6),
                        Text(isSw ? 'OTP Imepokelewa' : 'OTP Received',
                            style: TextStyle(
                                fontWeight: FontWeight.bold,
                                color: Colors.amber.shade700,
                                fontSize: 13)),
                      ]),
                      const SizedBox(height: 10),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: _autoFillOtp
                            .split('')
                            .map((d) => Container(
                                  margin:
                                      const EdgeInsets.symmetric(horizontal: 4),
                                  width: 36,
                                  height: 44,
                                  decoration: BoxDecoration(
                                    color: isDark
                                        ? const Color(0xFF0D1117)
                                        : Colors.white,
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(
                                        color: Colors.amber.shade400,
                                        width: 1.5),
                                  ),
                                  child: Center(
                                      child: Text(d,
                                          style: TextStyle(
                                              fontSize: 22,
                                              fontWeight: FontWeight.bold,
                                              color: Colors.amber.shade800))),
                                ))
                            .toList(),
                      ),
                      const SizedBox(height: 8),
                      Row(children: [
                        Icon(Icons.touch_app_rounded,
                            color: Colors.amber.shade700, size: 14),
                        const SizedBox(width: 5),
                        Text(
                            isSw
                                ? 'Angalia na bonyeza Thibitisha'
                                : 'Review and click Verify',
                            style: TextStyle(
                                fontSize: 11, color: Colors.amber.shade700)),
                      ]),
                    ]),
              ),
              const SizedBox(height: 12),
            ],
            Row(children: [
              Icon(
                  _otpChannel == 'phone'
                      ? Icons.smartphone_rounded
                      : Icons.mail_outline_rounded,
                  size: 14,
                  color: textSecond),
              const SizedBox(width: 5),
              Text(
                  (isSw ? 'Nambari imetumwa: ' : 'Code sent to: ') + _otpTarget,
                  style: TextStyle(fontSize: 12, color: textSecond)),
            ]),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(
                  child: TextFormField(
                controller: _otpCtrl,
                keyboardType: TextInputType.number,
                maxLength: 6,
                textAlign: TextAlign.center,
                style: TextStyle(
                    fontSize: 20,
                    letterSpacing: 6,
                    fontWeight: FontWeight.bold,
                    color: textPrimary),
                decoration: InputDecoration(
                  counterText: '',
                  hintText: '- - - - - -',
                  hintStyle: TextStyle(
                      letterSpacing: 6, color: textPrimary.withOpacity(0.25)),
                  filled: true,
                  fillColor: isDark ? const Color(0xFF0D1117) : Colors.white,
                  border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide(color: otpBorder)),
                  enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide(color: otpBorder)),
                  focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: const BorderSide(
                          color: Color(0xFF2E7D32), width: 1.5)),
                  errorText:
                      _verificationError.isNotEmpty ? _verificationError : null,
                  suffixIcon: _autoFillOtp.isNotEmpty
                      ? IconButton(
                          icon: const Icon(Icons.content_paste_rounded,
                              color: Color(0xFF1976D2)),
                          onPressed: () {
                            _otpCtrl.text = _autoFillOtp;
                            _snack(
                                isSw
                                    ? 'OTP imewekwa! Bonyeza Thibitisha'
                                    : 'OTP pasted! Click Verify',
                                Colors.green);
                          })
                      : null,
                ),
              )),
              const SizedBox(width: 10),
              ElevatedButton.icon(
                onPressed: _otpLoading ? null : _verifyOtp,
                icon: _otpLoading
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Colors.white))
                    : const Icon(Icons.check_circle_outline_rounded, size: 18),
                label: Text(isSw ? 'Thibitisha' : 'Verify',
                    style: const TextStyle(fontWeight: FontWeight.bold)),
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF2E7D32),
                  foregroundColor: Colors.white,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12)),
                ),
              ),
            ]),
            TextButton.icon(
              onPressed: _otpLoading ? null : _sendOtp,
              icon: const Icon(Icons.refresh_rounded, size: 16),
              label: Text(isSw ? 'Tuma Tena' : 'Resend Code'),
              style: TextButton.styleFrom(
                  foregroundColor: const Color(0xFF1976D2)),
            ),
          ],
        ],
      ]),
    );
  }

  Widget _channelBtn(String label, IconData icon, bool selected, bool isDark,
      VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(vertical: 11),
        decoration: BoxDecoration(
          color: selected
              ? const Color(0xFF1976D2)
              : (isDark ? const Color(0xFF0D1117) : Colors.grey.shade100),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
              color: selected
                  ? const Color(0xFF1976D2)
                  : (isDark ? Colors.white12 : Colors.grey.shade300)),
        ),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(icon,
              size: 17,
              color: selected
                  ? Colors.white
                  : (isDark ? Colors.white54 : Colors.grey.shade600)),
          const SizedBox(width: 6),
          Text(label,
              style: TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: 13,
                  color: selected
                      ? Colors.white
                      : (isDark ? Colors.white54 : Colors.grey.shade700))),
        ]),
      ),
    );
  }

  Widget _field(
      {required TextEditingController ctrl,
      required String label,
      required IconData icon,
      required Color fill,
      required Color border,
      required Color text,
      String? hint,
      TextInputType? type,
      String? Function(String?)? validator}) {
    return TextFormField(
      controller: ctrl,
      keyboardType: type,
      style: TextStyle(color: text, fontSize: 14),
      validator: validator,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        labelStyle: TextStyle(color: text.withOpacity(0.6), fontSize: 13),
        hintStyle: TextStyle(color: text.withOpacity(0.35), fontSize: 13),
        prefixIcon: Icon(icon, size: 20, color: const Color(0xFF2E7D32)),
        filled: true,
        fillColor: fill,
        border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide(color: border)),
        enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide(color: border)),
        focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFF2E7D32), width: 1.5)),
        errorBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Colors.red)),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      ),
    );
  }

  Widget _passField(
      {required TextEditingController ctrl,
      required String label,
      required bool obscure,
      required VoidCallback onToggle,
      required Color fill,
      required Color border,
      required Color text,
      String? Function(String?)? validator}) {
    return TextFormField(
      controller: ctrl,
      obscureText: obscure,
      style: TextStyle(color: text, fontSize: 14),
      validator: validator,
      decoration: InputDecoration(
        labelText: label,
        labelStyle: TextStyle(color: text.withOpacity(0.6), fontSize: 13),
        prefixIcon: const Icon(Icons.lock_outline_rounded,
            size: 20, color: Color(0xFF2E7D32)),
        suffixIcon: IconButton(
          icon: Icon(
              obscure
                  ? Icons.visibility_off_outlined
                  : Icons.visibility_outlined,
              size: 20,
              color: text.withOpacity(0.5)),
          onPressed: onToggle,
        ),
        filled: true,
        fillColor: fill,
        border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide(color: border)),
        enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide(color: border)),
        focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Color(0xFF2E7D32), width: 1.5)),
        errorBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: Colors.red)),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      ),
    );
  }
}
